import { describe, expect, it } from 'vitest';
import listing from '../models/__fixtures__/hyperouter-models.json';
import { parseListing } from '../models/catalog';
import { PUBLIC_CHAT_MODELS, resolveChatModel, tokenPrice } from '../models/chat';
import { AgentCostMeter, agentAllowancePeriod, defaultTurnEstimateUsd, responseCostUsd, rollingAverage, turnsLeft } from './agent';
import { AGENT_ALLOWANCE_USD } from './config';

const models = parseListing(listing).models.filter((m) => m.kind === 'chat');
const priceOf = (publicId: string) => tokenPrice(models.find((m) => m.id === resolveChatModel(publicId, models))!);

describe('agent allowance math (D-012)', () => {
  it('estimates a default turn as 10k prompt + 1.2k completion tokens', () => {
    expect(defaultTurnEstimateUsd({ prompt: 0.000001, completion: 0.00001 })).toBeCloseTo(0.01 + 0.012, 12);
    expect(defaultTurnEstimateUsd(null)).toBe(0);
    // DeepSeek V4.1 Flash routes to the cheaper -us variant: 10k × $0.075/M + 1.2k × $0.30/M.
    expect(defaultTurnEstimateUsd(priceOf('deepseek-v4.1-flash'))).toBeCloseTo(0.00111, 9);
    expect(defaultTurnEstimateUsd(priceOf('claude-opus-5.5'))).toBeCloseTo(0.064, 9);
  });

  it('charges usage.cost when present, else tokens × token price', () => {
    const price = { prompt: 0.000002, completion: 0.00001 };
    expect(responseCostUsd({ promptTokens: 1000, completionTokens: 100, costUsd: 0.5 }, price)).toBe(0.5);
    expect(responseCostUsd({ promptTokens: 1000, completionTokens: 100, costUsd: null }, price)).toBeCloseTo(0.003, 12);
    expect(responseCostUsd({ promptTokens: 1000, completionTokens: 100, costUsd: null }, null)).toBe(0);
  });

  it('does not charge classifier calls', () => {
    const meter = new AgentCostMeter();
    const price = { prompt: 0.000001, completion: 0.000001 };
    meter.add('turn', { promptTokens: 0, completionTokens: 0, costUsd: 0.01 }, price);
    meter.add('retry', { promptTokens: 1000, completionTokens: 0, costUsd: null }, price);
    meter.add('summary', { promptTokens: 0, completionTokens: 0, costUsd: 0.002 }, price);
    meter.add('classifier', { promptTokens: 0, completionTokens: 0, costUsd: 0.5 }, price);
    expect(meter.chargedUsd).toBeCloseTo(0.013, 12);
    expect(meter.freeUsd).toBe(0.5);
  });

  it('counts turns left per model', () => {
    expect(turnsLeft(1.2, 0, 0.064)).toBe(18);
    expect(turnsLeft(1.2, 1.19, 0.064)).toBe(0);
    expect(turnsLeft(1.2, 1.3, 0.001)).toBe(0);
    expect(turnsLeft(1, 0, 0.25)).toBe(4);
    expect(turnsLeft(1, 0, 0)).toBe(0);
    const table = Object.fromEntries(PUBLIC_CHAT_MODELS.map((m) => [m.id, turnsLeft(AGENT_ALLOWANCE_USD.starter, 0, defaultTurnEstimateUsd(priceOf(m.id)))]));
    expect(table['deepseek-v4.1-flash']).toBe(1081);
    expect(table['claude-opus-5.5']).toBe(18);
    expect(table['gpt-6-astra']).toBe(7);
  });

  it('averages recent turn costs, ignoring zero-cost turns', () => {
    expect(rollingAverage([])).toBeNull();
    expect(rollingAverage([0, 0])).toBeNull();
    expect(rollingAverage([2, 4, 0])).toBe(3);
  });

  it('resets on the billing period start, monthly slices, else the UTC calendar month', () => {
    const anchor = Date.UTC(2026, 0, 31, 12);
    expect(agentAllowancePeriod(Date.UTC(2026, 1, 10), anchor)).toEqual({ start: anchor, resetsAt: Date.UTC(2026, 1, 28, 12) });
    expect(agentAllowancePeriod(Date.UTC(2026, 1, 28, 12), anchor)).toEqual({ start: Date.UTC(2026, 1, 28, 12), resetsAt: Date.UTC(2026, 2, 31, 12) });
    // Yearly plan anchored a year ago still resets monthly.
    const yearly = Date.UTC(2025, 10, 15);
    expect(agentAllowancePeriod(Date.UTC(2026, 10, 25), yearly)).toEqual({ start: Date.UTC(2026, 10, 15), resetsAt: Date.UTC(2026, 11, 15) });
    expect(agentAllowancePeriod(Date.UTC(2026, 10, 25, 8), null)).toEqual({ start: Date.UTC(2026, 10, 1), resetsAt: Date.UTC(2026, 11, 1) });
    // An anchor in the future (clock skew) falls back to the calendar month.
    expect(agentAllowancePeriod(Date.UTC(2026, 10, 25), Date.UTC(2026, 11, 1)).start).toBe(Date.UTC(2026, 10, 1));
  });
});
