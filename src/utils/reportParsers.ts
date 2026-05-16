import { timestampms } from '@/utils/formatters/timeformat';

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return timestampms(date);
}

export function extractPair(message: string): string {
  const pairMatch = message.match(/for\s+([A-Z0-9]+\/[A-Z0-9]+(?::[A-Z0-9]+)?)/i);
  return pairMatch?.[1] ?? 'n/a';
}

export function extractPairFlexible(message: string): string {
  const directPair = extractPair(message);
  if (directPair !== 'n/a') {
    return directPair;
  }
  const genericPairMatch = message.match(/([A-Z0-9]+\/[A-Z0-9]+(?::[A-Z0-9]+)?)/i);
  return genericPairMatch?.[1] ?? 'n/a';
}
