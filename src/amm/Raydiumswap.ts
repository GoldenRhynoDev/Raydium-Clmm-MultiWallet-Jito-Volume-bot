import {
  ApiV3PoolInfoConcentratedItem,
  ClmmKeys,
  ComputeClmmPoolInfo,
  PoolUtils,
  ReturnTypeFetchMultiplePoolTickArrays,
  ApiV3Token,
  TickArray,
  Raydium,
} from '@raydium-io/raydium-sdk-v2';
import {
  VersionedTransaction,
  BlockhashWithExpiryBlockHeight,
  Transaction,
  Connection,
  PublicKey,
  Signer,
  Keypair,
  ComputeBudgetInstruction,
} from '@solana/web3.js';

import BN from 'bn.js';
import {
  initSdk,
  logger,
  isValidClmm,
  sleep,
  getWallet,
  txVersion,
  RPC_ENDPOINT,
  POOL_ADDRESS,
  COMPUTE_UNIT_LIMIT,
  COMPUTE_UNIT_PRICE,
} from '../config';
const poolId = POOL_ADDRESS;

export const getPoolInfo = async (connection: Connection, wallet: Keypair) => {
  const raydium = await initSdk(connection, wallet, 'mainnet');
  let poolInfo: ApiV3PoolInfoConcentratedItem;

  let poolKeys: ClmmKeys | undefined;
  let clmmPoolInfo: ComputeClmmPoolInfo;
  let tickCache: ReturnTypeFetchMultiplePoolTickArrays;

  if (raydium.cluster === 'mainnet') {
    // note: api doesn't support get devnet pool info, so in devnet else we go rpc method
    // if you wish to get pool info from rpc, also can modify logic to go rpc method directly

    const data = await raydium.api.fetchPoolById({ ids: poolId });
    sleep(1000);
    poolInfo = data[0] as ApiV3PoolInfoConcentratedItem;
    if (!isValidClmm(poolInfo.programId)) throw new Error('target pool is not CLMM pool');
    sleep(1000);
    clmmPoolInfo = await PoolUtils.fetchComputeClmmInfo({
      connection: raydium.connection,
      poolInfo,
    });
    sleep(1000);
    tickCache = await PoolUtils.fetchMultiplePoolTickArrays({
      connection: raydium.connection,
      poolKeys: [clmmPoolInfo],
    });
  } else {
    sleep(1000);
    const data = await raydium.clmm.getPoolInfoFromRpc(poolId);
    poolInfo = data.poolInfo;
    poolKeys = data.poolKeys;
    clmmPoolInfo = data.computePoolInfo;
    tickCache = data.tickData;
  }

  return {
    raydium: raydium,
    poolInfo: poolInfo,
    poolKeys: poolKeys,
    clmmPoolInfo: clmmPoolInfo,
    tickCache: tickCache,
  };
};
export const getAmountOut = async (
  raydium: Raydium,
  poolInfo: ApiV3PoolInfoConcentratedItem,
  clmmPoolInfo: ComputeClmmPoolInfo,
  tokenAmount: BN,
  tickCache: ReturnTypeFetchMultiplePoolTickArrays,
  slippage: number,
  flag: boolean = true, //true = sell
) => {
  let tokenOut = flag ? poolInfo.mintA : poolInfo.mintB;
  const { minAmountOut, remainingAccounts } = await PoolUtils.computeAmountOutFormat({
    poolInfo: clmmPoolInfo,
    tickArrayCache: tickCache[poolId],
    amountIn: tokenAmount,
    tokenOut: tokenOut,
    slippage: slippage,
    epochInfo: await raydium.fetchEpochInfo(),
  });
  return {
    minAmountOut,
    remainingAccounts,
  };
};

export const makeSwapTransaction = async (
  raydium: Raydium,
  poolInfo: ApiV3PoolInfoConcentratedItem,
  clmmPoolInfo: ComputeClmmPoolInfo,
  poolKeys: ClmmKeys | undefined,
  amountIn: BN,
  amountOutMin: BN,
  remainingAccounts: PublicKey[],
  swapMode: 'BUY' | 'SELL' = 'BUY',
) => {
  const inputMint = swapMode === 'BUY' ? poolInfo.mintA.address : poolInfo.mintB.address;
  const { transaction } = await raydium.clmm.swap({
    poolInfo,
    poolKeys,
    inputMint: inputMint,
    amountIn: amountIn,
    amountOutMin: amountOutMin,
    observationId: clmmPoolInfo.observationId,
    ownerInfo: {
      useSOLBalance: true,
    },
    remainingAccounts,
    txVersion,
  });

  return transaction as VersionedTransaction;
};
export const confirm = async (
  connection: Connection,
  signature: string,
  latestBlockhash: BlockhashWithExpiryBlockHeight,
) => {
  const confirmation = await connection.confirmTransaction(
    {
      signature,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
      blockhash: latestBlockhash.blockhash,
    },
    'confirmed',
  );
  return { confirmed: !confirmation.value.err, signature };
};
export const executeAndConfirm = async (
  connection: Connection,
  transaction: VersionedTransaction,
  latestBlockhash: BlockhashWithExpiryBlockHeight,
): Promise<{ confirmed: boolean; signature?: string; error?: string }> => {
  logger.debug('Executing transaction...');
  const signature = await connection.sendRawTransaction(transaction.serialize(), {
    preflightCommitment: connection.commitment,
  });
  sleep(1000);
  return await confirm(connection, signature, latestBlockhash);
};
