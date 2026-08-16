import { describe, it, expect } from 'vitest';
import { shortStrategyName } from '@/utils/strategyLabel';

describe('shortStrategyName', () => {
  it('strips the Printer_ prefix', () => {
    expect(shortStrategyName('Printer_v1')).toBe('v1');
    expect(shortStrategyName('Printer_v2')).toBe('v2');
    expect(shortStrategyName('Printer_v4')).toBe('v4');
    expect(shortStrategyName('Printer_v5')).toBe('v5');
    expect(shortStrategyName('Printer_v6')).toBe('v6');
  });

  it('keeps the qualifier when the prefix has no underscore', () => {
    expect(shortStrategyName('PrinterLive_v2')).toBe('Live_v2');
    expect(shortStrategyName('PrinterLive_v8')).toBe('Live_v8');
    expect(shortStrategyName('PrinterSafe_v2')).toBe('Safe_v2');
  });

  it('leaves unrelated strategy names untouched', () => {
    expect(shortStrategyName('Claid')).toBe('Claid');
    expect(shortStrategyName('SampleStrategy')).toBe('SampleStrategy');
  });

  it('never returns an empty label for a bare prefix match', () => {
    expect(shortStrategyName('Printer')).toBe('Printer');
    expect(shortStrategyName('Printer_')).toBe('Printer_');
  });

  it('returns an empty string for missing values', () => {
    expect(shortStrategyName(undefined)).toBe('');
    expect(shortStrategyName(null)).toBe('');
    expect(shortStrategyName('')).toBe('');
  });
});
