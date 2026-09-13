import { decodeFunctionData, type Hex } from 'viem';
import { CALIBUR_ABI, CALIBUR_ADDRESS, CALIBUR_DELEGATION_CODE, assertCaliburDeployment, inspectCaliburAccountCode,
  buildCaliburSelfTransaction, buildCaliburSetupTransaction } from './calibur.js';
import { SIMPLE7702_ABI, SIMPLE7702_ADDRESS, SIMPLE7702_DELEGATION_CODE, assertSimple7702Deployment, inspectSimple7702AccountCode,
  buildSimple7702SelfTransaction, buildSimple7702SetupTransaction } from './simple7702.js';
export type DelegatedExecution = 'calibur' | 'simple7702';
export const isDelegatedExecution = (value: unknown): value is DelegatedExecution => value === 'calibur' || value === 'simple7702';

/** Explicit contract selection. Historical Calibur data never aliases the new implementation. */
export function delegationFor(execution: DelegatedExecution) {
  if (execution === 'calibur') return {
    execution, label: 'Calibur', address: CALIBUR_ADDRESS, delegationCode: CALIBUR_DELEGATION_CODE, setupKind: 'calibur-setup' as const,
    assertDeployment: assertCaliburDeployment, inspectAccountCode: inspectCaliburAccountCode,
    buildTransaction: buildCaliburSelfTransaction, buildSetupTransaction: buildCaliburSetupTransaction,
    decodeCalls(data: Hex) {
      const decoded = decodeFunctionData({ abi: CALIBUR_ABI, data });
      if (decoded.functionName !== 'execute' || !decoded.args[0].revertOnFailure) throw new Error('Invalid Calibur batch');
      return decoded.args[0].calls;
    },
  };
  if (execution === 'simple7702') return {
    execution, label: 'Simple7702Account', address: SIMPLE7702_ADDRESS, delegationCode: SIMPLE7702_DELEGATION_CODE, setupKind: 'simple7702-setup' as const,
    assertDeployment: assertSimple7702Deployment, inspectAccountCode: inspectSimple7702AccountCode,
    buildTransaction: buildSimple7702SelfTransaction, buildSetupTransaction: buildSimple7702SetupTransaction,
    decodeCalls(data: Hex) {
      const decoded = decodeFunctionData({ abi: SIMPLE7702_ABI, data });
      if (decoded.functionName !== 'executeBatch') throw new Error('Invalid Simple7702Account batch');
      return decoded.args[0].map(call => ({ to: call.target, value: call.value, data: call.data }));
    },
  };
  throw new Error('Select an explicit delegated execution mode');
}
