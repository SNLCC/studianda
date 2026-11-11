import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type {
  ModelServiceConnection,
  ModelServiceModel,
  ModelServiceRouting
} from '@studianda/shared';
import { afterAll, describe, expect, it } from 'vitest';
import {
  modelSupports,
  resolveModelService,
  resolveOmniService,
  resolveVisualService
} from '../src/model-services.js';
import { SecretStore } from '../src/secrets.js';
import { Store } from '../src/store.js';

const dataDir = mkdtempSync(path.join(tmpdir(), 'studianda-model-services-'));
const store = new Store(dataDir);
const secrets = new SecretStore();

afterAll(() => {
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function model(name: string, capabilities: string[]): ModelServiceModel {
  return { id: name, name, capabilities, source: 'user', enabled: true };
}

const VISION_MODEL = model('vision-model', ['chat', 'vision']);
const OMNI_MODEL = model('omni-model', ['omni']);
const PLAIN_CHAT_MODEL = model('chat-model', ['chat']);
const AUDIO_CHAT_MODEL = model('audio-chat-model', ['chat', 'audio']);

function configure(routing: ModelServiceRouting): void {
  const connections: ModelServiceConnection[] = [
    {
      id: 'c1',
      name: '测试平台',
      platform: 'custom',
      // 带尾斜杠：解析结果必须去掉，保持与原实现一致。
      baseUrl: 'https://api.example.com/v1/',
      models: [VISION_MODEL, OMNI_MODEL, PLAIN_CHAT_MODEL, AUDIO_CHAT_MODEL]
    }
  ];
  store.updateSettings({
    'model.services': JSON.stringify(connections),
    'model.routing': JSON.stringify(routing)
  });
  secrets.set('platform.c1.api_key', 'k-1');
}

describe('modelSupports', () => {
  it('treats omni as covering chat / vision / audio', () => {
    expect(modelSupports('omni', OMNI_MODEL)).toBe(true);
    expect(modelSupports('vision', OMNI_MODEL)).toBe(true);
    expect(modelSupports('chat', OMNI_MODEL)).toBe(true);
    expect(modelSupports('audio', OMNI_MODEL)).toBe(true);
  });

  it('does not invent capabilities from a model name', () => {
    expect(modelSupports('vision', PLAIN_CHAT_MODEL)).toBe(false);
    expect(modelSupports('audio', PLAIN_CHAT_MODEL)).toBe(false);
    expect(modelSupports('vision', VISION_MODEL)).toBe(true);
    expect(modelSupports('chat', VISION_MODEL)).toBe(true);
    expect(modelSupports('audio', VISION_MODEL)).toBe(false);
    expect(modelSupports('omni', VISION_MODEL)).toBe(false);
  });
});

describe('resolveVisualService', () => {
  it('prefers an explicit vision assignment', () => {
    configure({
      vision: { connectionId: 'c1', model: 'vision-model' },
      omni: { connectionId: 'c1', model: 'omni-model' },
      chat: { connectionId: 'c1', model: 'chat-model' }
    });
    const resolved = resolveVisualService(store, secrets);
    expect(resolved).toMatchObject({
      connectionId: 'c1',
      model: 'vision-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'k-1'
    });
  });

  it('falls back to the omni assignment when vision is unset', () => {
    configure({
      omni: { connectionId: 'c1', model: 'omni-model' },
      chat: { connectionId: 'c1', model: 'vision-model' }
    });
    expect(resolveVisualService(store, secrets)).toMatchObject({ model: 'omni-model' });
  });

  it('falls back to a chat model only when it really has vision capability', () => {
    configure({ chat: { connectionId: 'c1', model: 'vision-model' } });
    expect(resolveVisualService(store, secrets)).toMatchObject({ model: 'vision-model' });
  });

  it('returns null when the chat model has no vision capability', () => {
    configure({ chat: { connectionId: 'c1', model: 'chat-model' } });
    expect(resolveVisualService(store, secrets)).toBeNull();
  });

  it('treats a chat-assigned omni model as vision-capable', () => {
    configure({ chat: { connectionId: 'c1', model: 'omni-model' } });
    expect(resolveVisualService(store, secrets)).toMatchObject({ model: 'omni-model' });
  });

  it('returns null when nothing is assigned', () => {
    configure({});
    expect(resolveVisualService(store, secrets)).toBeNull();
  });
});

describe('resolveOmniService', () => {
  it('prefers the omni assignment', () => {
    configure({
      omni: { connectionId: 'c1', model: 'omni-model' },
      chat: { connectionId: 'c1', model: 'audio-chat-model' }
    });
    expect(resolveOmniService(store, secrets)).toMatchObject({ model: 'omni-model' });
  });

  it('falls back to a chat model with audio or omni capability', () => {
    configure({ chat: { connectionId: 'c1', model: 'audio-chat-model' } });
    expect(resolveOmniService(store, secrets)).toMatchObject({
      model: 'audio-chat-model'
    });
    configure({ chat: { connectionId: 'c1', model: 'omni-model' } });
    expect(resolveOmniService(store, secrets)).toMatchObject({ model: 'omni-model' });
  });

  it('returns null for a plain chat model', () => {
    configure({ chat: { connectionId: 'c1', model: 'chat-model' } });
    expect(resolveOmniService(store, secrets)).toBeNull();
  });
});

describe('existing model resolution stays the same', () => {
  it('resolves chat exactly as before (baseUrl trimmed, key from the connection)', () => {
    configure({ chat: { connectionId: 'c1', model: 'chat-model' } });
    expect(resolveModelService(store, secrets, 'chat')).toMatchObject({
      connectionId: 'c1',
      model: 'chat-model',
      baseUrl: 'https://api.example.com/v1',
      apiKey: 'k-1'
    });
  });

  it('still returns null when the assignment is missing', () => {
    configure({});
    expect(resolveModelService(store, secrets, 'chat')).toBeNull();
    expect(resolveModelService(store, secrets, 'embedding')).toBeNull();
    expect(resolveModelService(store, secrets, 'translation')).toBeNull();
  });
});
