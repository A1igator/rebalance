import type { Portfolio, TradePlan } from './core.js';
import type { Operation } from './transactions.js';

export const GRAPH = {
  intent: ['config'], config: ['reconcile', 'wait'], reconcile: ['observe', 'wait'],
  observe: ['plan'], plan: ['quote', 'wait'], quote: ['execute', 'wait'],
  execute: ['receipt'], receipt: ['reconcile'], wait: ['config'], error: ['config'],
} as const;
export type Node = keyof typeof GRAPH;
export type GraphState = { node: Node; trace: Node[] };
export type GraphDependencies = {
  configured(): Promise<boolean>;
  reconcile(): Promise<{ blocked: boolean; operation: Operation | null }>;
  observe(): Promise<Portfolio>;
  plan(portfolio: Portfolio): TradePlan | null;
  quote(trade: TradePlan): Promise<unknown>;
  execute(trade: TradePlan, quote: unknown): Promise<Operation>;
  publish(graph: GraphState, operation: Operation | null): Promise<void>;
  canExecute: boolean;
};

/** One traversal of the graph. The timer only schedules the next traversal. */
export async function runGraph(deps: GraphDependencies): Promise<GraphState> {
  const trace: Node[] = [];
  let operation: Operation | null = null;
  const enter = async (node: Node) => {
    trace.push(node);
    const graph = { node, trace: [...trace] };
    await deps.publish(graph, operation);
    return graph;
  };
  try {
    await enter('config');
    if (!await deps.configured()) return await enter('wait');
    await enter('reconcile');
    const result = await deps.reconcile();
    operation = result.operation;
    if (result.blocked) return await enter('wait');
    await enter('observe');
    const portfolio = await deps.observe();
    await enter('plan');
    const trade = deps.plan(portfolio);
    if (!trade) return await enter('wait');
    await enter('quote');
    const quote = await deps.quote(trade);
    if (!deps.canExecute) {
      operation = { status: 'needs-rebalance', message: trade.reason };
      return await enter('wait');
    }
    await enter('execute');
    operation = await deps.execute(trade, quote);
    return await enter('receipt');
  } catch (error) {
    await enter('error');
    throw error;
  }
}
