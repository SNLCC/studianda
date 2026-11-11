import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_BATCHES,
  DEFAULT_MAX_PARALLEL,
  DEFAULT_OUTPUT_RESERVE,
  DEFAULT_REMOTE_WORKERS,
  MAX_CONTEXT_WINDOW,
  MAX_OUTPUT_RESERVE,
  MAX_READ_BATCHES,
  MAX_WORKERS,
  MIN_CONTEXT_WINDOW,
  MIN_INPUT_BUDGET,
  MIN_OUTPUT_RESERVE,
  gotoWorkers,
  inputBudget,
  readCapacity
} from '../src/capacity.js';

const DEFAULT_CAPACITY = {
  maxParallel: 0,
  maxReadBatches: 12,
  contextWindow: DEFAULT_CONTEXT_WINDOW,
  outputReserve: DEFAULT_OUTPUT_RESERVE
};

describe('reading capacity settings', () => {
  it('uses the documented defaults when the keys are absent', () => {
    expect(DEFAULT_MAX_BATCHES).toBe(12);
    expect(MAX_WORKERS).toBe(8);
    expect(MAX_READ_BATCHES).toBe(64);
    expect(DEFAULT_MAX_PARALLEL).toBe(0);
    expect(DEFAULT_REMOTE_WORKERS).toBe(4);
    expect(DEFAULT_CONTEXT_WINDOW).toBe(65536);
    expect(DEFAULT_OUTPUT_RESERVE).toBe(4096);
    expect(readCapacity({})).toEqual(DEFAULT_CAPACITY);
    expect(readCapacity(undefined)).toEqual(DEFAULT_CAPACITY);
    expect(readCapacity(null)).toEqual(DEFAULT_CAPACITY);
  });

  it('accepts numeric strings and numbers alike', () => {
    expect(
      readCapacity({
        'reading.max_parallel': '3',
        'reading.max_read_batches': '20'
      })
    ).toEqual({ ...DEFAULT_CAPACITY, maxParallel: 3, maxReadBatches: 20 });
    // 设置值也可能是已经解析好的数字（JSON/数字输入）。
    expect(
      readCapacity({
        'reading.max_parallel': 5,
        'reading.max_read_batches': 32
      })
    ).toEqual({ ...DEFAULT_CAPACITY, maxParallel: 5, maxReadBatches: 32 });
  });

  it('clamps out-of-range values instead of throwing', () => {
    expect(readCapacity({ 'reading.max_parallel': '99' })).toMatchObject({
      maxParallel: MAX_WORKERS
    });
    expect(readCapacity({ 'reading.max_parallel': '-5' })).toMatchObject({
      maxParallel: 0
    });
    expect(readCapacity({ 'reading.max_read_batches': '0' })).toMatchObject({
      maxReadBatches: 1
    });
    expect(readCapacity({ 'reading.max_read_batches': '999' })).toMatchObject({
      maxReadBatches: MAX_READ_BATCHES
    });
    expect(readCapacity({ 'reading.max_read_batches': '-3' })).toMatchObject({
      maxReadBatches: 1
    });
  });

  it('falls back to defaults on unparseable values', () => {
    expect(
      readCapacity({
        'reading.max_parallel': 'abc',
        'reading.max_read_batches': 'many'
      })
    ).toEqual(DEFAULT_CAPACITY);
    expect(
      readCapacity({
        'reading.max_parallel': '   ',
        'reading.max_read_batches': ''
      })
    ).toEqual(DEFAULT_CAPACITY);
    // 小数按整数部分处理，不做四舍五入到更大的值。
    expect(readCapacity({ 'reading.max_parallel': '2.9' })).toMatchObject({
      maxParallel: 2
    });
  });
});

describe('reading context window and output reserve', () => {
  it('reads explicit values', () => {
    expect(
      readCapacity({
        'reading.context_window': '128000',
        'reading.output_reserve': '8192'
      })
    ).toMatchObject({ contextWindow: 128000, outputReserve: 8192 });
    // 数字输入同样接受。
    expect(
      readCapacity({ 'reading.context_window': 32768, 'reading.output_reserve': 2048 })
    ).toMatchObject({ contextWindow: 32768, outputReserve: 2048 });
  });

  it('clamps the context window to 8192-4000000', () => {
    expect(readCapacity({ 'reading.context_window': '1' })).toMatchObject({
      contextWindow: MIN_CONTEXT_WINDOW
    });
    expect(readCapacity({ 'reading.context_window': '99999999' })).toMatchObject({
      contextWindow: MAX_CONTEXT_WINDOW
    });
    expect(readCapacity({ 'reading.context_window': '-5' })).toMatchObject({
      contextWindow: MIN_CONTEXT_WINDOW
    });
  });

  it('clamps the output reserve to 512-32768 (when the window is large enough)', () => {
    expect(
      readCapacity({
        'reading.context_window': String(MAX_CONTEXT_WINDOW),
        'reading.output_reserve': '0'
      })
    ).toMatchObject({ outputReserve: MIN_OUTPUT_RESERVE });
    expect(
      readCapacity({
        'reading.context_window': String(MAX_CONTEXT_WINDOW),
        'reading.output_reserve': '999999'
      })
    ).toMatchObject({ outputReserve: MAX_OUTPUT_RESERVE });
  });

  it('falls back to the default reserve when it is not below half the window', () => {
    // 20000 的一半是 10000；填 12000 不合法 → 回退默认 4096。
    expect(
      readCapacity({
        'reading.context_window': '20000',
        'reading.output_reserve': '12000'
      })
    ).toMatchObject({ contextWindow: 20000, outputReserve: DEFAULT_OUTPUT_RESERVE });
    // 默认窗口下填 40000 会先被钳到 32768，而 32768 不满足 < 32768，于是回退默认。
    expect(
      readCapacity({ 'reading.output_reserve': '40000' })
    ).toMatchObject({ outputReserve: DEFAULT_OUTPUT_RESERVE });
    // 窗口很小时，回退后的默认预留也必须小于窗口的一半。
    const small = readCapacity({
      'reading.context_window': String(MIN_CONTEXT_WINDOW),
      'reading.output_reserve': '4096'
    });
    expect(small.outputReserve).toBeLessThan(small.contextWindow / 2);
    expect(small.outputReserve).toBe(4095);
  });

  it('falls back to defaults on unparseable window/reserve values', () => {
    expect(
      readCapacity({
        'reading.context_window': 'lots',
        'reading.output_reserve': 'many'
      })
    ).toEqual(DEFAULT_CAPACITY);
    expect(
      readCapacity({
        'reading.context_window': '   ',
        'reading.output_reserve': ''
      })
    ).toEqual(DEFAULT_CAPACITY);
  });

  it('never returns a reserve that is not below half the window', () => {
    for (const window of ['8192', '16384', '65536', '1000000']) {
      for (const reserve of ['512', '4096', '20000', '32768', '999999']) {
        const capacity = readCapacity({
          'reading.context_window': window,
          'reading.output_reserve': reserve
        });
        expect(capacity.outputReserve).toBeLessThan(capacity.contextWindow / 2);
      }
    }
  });
});

describe('reading input budget', () => {
  it('subtracts reserve plus protocol slack from the window', () => {
    expect(inputBudget({ contextWindow: 65536, outputReserve: 4096 })).toBe(60416);
    expect(inputBudget({ contextWindow: 128000, outputReserve: 8192 })).toBe(118784);
    expect(inputBudget(DEFAULT_CAPACITY)).toBe(60416);
  });

  it('uses the value computed from user settings', () => {
    const capacity = readCapacity({
      'reading.context_window': '20000',
      'reading.output_reserve': '8000'
    });
    expect(inputBudget(capacity)).toBe(20000 - 8000 - 1024);
  });

  it('never drops below the 1024 floor', () => {
    expect(inputBudget({ contextWindow: 8192, outputReserve: 12000 })).toBe(
      MIN_INPUT_BUDGET
    );
    expect(inputBudget({ contextWindow: 0, outputReserve: 0 })).toBe(MIN_INPUT_BUDGET);
  });
});

describe('reading concurrency workers', () => {
  it('uses 1 worker for local / LAN model services when set to auto', () => {
    expect(gotoWorkers('http://localhost:11434/v1', 0)).toBe(1);
    expect(gotoWorkers('http://127.0.0.1:11434/v1', 0)).toBe(1);
    expect(gotoWorkers('http://[::1]:11434/v1', 0)).toBe(1);
    expect(gotoWorkers('http://ollama.local/v1', 0)).toBe(1);
    expect(gotoWorkers('http://my-box.local:11434/v1', 0)).toBe(1);
  });

  it('uses the measured remote default when set to auto', () => {
    expect(gotoWorkers('https://api.deepseek.com/v1', 0)).toBe(DEFAULT_REMOTE_WORKERS);
    expect(gotoWorkers('https://api.openai.com/v1', 0)).toBe(DEFAULT_REMOTE_WORKERS);
    expect(gotoWorkers('', 0)).toBe(DEFAULT_REMOTE_WORKERS);
    expect(gotoWorkers('not a url', 0)).toBe(DEFAULT_REMOTE_WORKERS);
    // 缺协议头的写法认不出主机名，按远程处理。
    expect(gotoWorkers('localhost:11434', 0)).toBe(DEFAULT_REMOTE_WORKERS);
  });

  it('lets an explicit user value win, capped at MAX_WORKERS', () => {
    expect(gotoWorkers('http://127.0.0.1:11434/v1', 2)).toBe(2);
    expect(gotoWorkers('https://api.deepseek.com/v1', 3)).toBe(3);
    expect(gotoWorkers('https://api.deepseek.com/v1', 99)).toBe(MAX_WORKERS);
    expect(gotoWorkers('https://api.deepseek.com/v1', -1)).toBe(DEFAULT_REMOTE_WORKERS);
    expect(gotoWorkers('https://api.deepseek.com/v1', Number.NaN)).toBe(
      DEFAULT_REMOTE_WORKERS
    );
  });
});
