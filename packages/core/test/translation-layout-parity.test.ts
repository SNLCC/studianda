import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  columnOf,
  decorateSegments,
  segmentKind
} from '../src/translation-layout.js';

const fixture = JSON.parse(
  readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      'fixtures',
      'translation-layout-parity.json'
    ),
    'utf8'
  )
) as {
  page: { width: number; height: number; spans: unknown[] };
  segments: Array<Record<string, unknown>>;
  boxes: Array<number[] | null>;
  before: {
    header_kind: string;
    body_kind: string;
    note_kind: string;
    columns: string[];
  };
  summary: { body_line_height: number; body_font_size: number; columns: number };
  after: Array<{ index: number; column: string; kind: string }>;
};

describe('translation layout parity with Python', () => {
  it('classifies furniture/body/note and columns', () => {
    expect(segmentKind(fixture.segments[0]!.text as string, fixture.boxes[0], 800, 11, 9)).toBe(
      fixture.before.header_kind
    );
    expect(segmentKind(fixture.segments[1]!.text as string, fixture.boxes[1], 800, 11, 11)).toBe(
      fixture.before.body_kind
    );
    expect(segmentKind(fixture.segments[4]!.text as string, fixture.boxes[4], 800, 11, 9)).toBe(
      fixture.before.note_kind
    );
    expect(fixture.boxes.map((box) => columnOf(box))).toEqual(fixture.before.columns);
  });

  it('decorates segments and returns layout summary', () => {
    const segments = fixture.segments.map((row) => ({ ...row }));
    expect(decorateSegments(segments, fixture.boxes, fixture.page)).toEqual(
      fixture.summary
    );
    expect(
      segments.map((row) => ({
        index: row.index,
        column: row.column,
        kind: row.kind
      }))
    ).toEqual(fixture.after);
  });
});
