import {
  ApiV3PoolInfoStandardItem,
  AmmV4Keys,
  ComputeClmmPoolInfo,
  AmmRpcData,
  ApiV3Token,
  TickArray,
  Raydium,
  sleep,
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
import fs from 'fs';
import BN from 'bn.js';
import {
  initSdk,
  logger,
  isValidAmm,
  getWallet,
  txVersion,
  RPC_ENDPOINT,
  POOL_ADDRESS,
  COMPUTE_UNIT_PRICE,
  COMPUTE_UNIT_LIMIT,
} from '../config';
const poolId = POOL_ADDRESS;

export const getPoolInfo = async (connection: Connection, wallet: Keypair) => {
  const raydium = await initSdk(connection, wallet, 'mainnet');
  let poolInfo: ApiV3PoolInfoStandardItem;

  let poolKeys: AmmV4Keys | undefined;
  let rpcData: AmmRpcData;

  if (raydium.cluster === 'mainnet') {
    // note: api doesn't support get devnet pool info, so in devnet else we go rpc method
    // if you wish to get pool info from rpc, also can modify logic to go rpc method directly

    const data = await raydium.api.fetchPoolById({ ids: poolId });
    sleep(1000);
    poolInfo = data[0] as ApiV3PoolInfoStandardItem;
    if (!isValidAmm(poolInfo.programId)) throw new Error('target pool is not AMM pool');

    poolKeys = await raydium.liquidity.getAmmPoolKeys(poolId);
    sleep(1000);

    rpcData = await raydium.liquidity.getRpcPoolInfo(poolId);
    sleep(1000);
  } else {
    const data = await raydium.liquidity.getPoolInfoFromRpc({ poolId });
    poolInfo = data.poolInfo;
    poolKeys = data.poolKeys;
    rpcData = data.poolRpcData;
  }

  return {
    raydium,
    poolInfo,
    poolKeys,
    rpcData,
  };
};
export const getAmountOut = async (
  raydium: Raydium,
  poolInfo: ApiV3PoolInfoStandardItem,
  rpcData: AmmRpcData,
  inputMint: string,
  amountIn: BN,
  slippage: number,
) => {
  const [baseReserve, quoteReserve, status] = [rpcData.baseReserve, rpcData.quoteReserve, rpcData.status.toNumber()];

  if (poolInfo.mintA.address !== inputMint && poolInfo.mintB.address !== inputMint)
    throw new Error('input mint does not match pool');

  const baseIn = inputMint === poolInfo.mintA.address;
  const [mintIn, mintOut] = baseIn ? [poolInfo.mintA, poolInfo.mintB] : [poolInfo.mintB, poolInfo.mintA];
  const out = raydium.liquidity.computeAmountOut({
    poolInfo: {
      ...poolInfo,
      baseReserve,
      quoteReserve,
      status,
      version: 4,
    },
    amountIn,
    mintIn: mintIn.address,
    mintOut: mintOut.address,
    slippage: slippage, // range: 1 ~ 0.0001, means 100% ~ 0.01%
  });
  return out;
};

export const makeSwapTransaction = async (
  raydium: Raydium,
  poolInfo: ApiV3PoolInfoStandardItem,
  poolKeys: AmmV4Keys | undefined,
  inputMint: string,
  amountIn: BN,
  amountOutMin: BN,
  fixedSide: 'in' | 'out' = 'out',
) => {
  const { transaction } = await raydium.liquidity.swap({
    poolInfo,
    poolKeys,
    amountIn,
    amountOut: amountOutMin,
    fixedSide: fixedSide,
    inputMint,
    txVersion,
    config: {
      inputUseSolBalance: true, // default: true, if you want to use existed wsol token account to pay token in, pass false
      outputUseSolBalance: true, // default: true, if you want to use existed wsol token account to receive token out, pass false
      associatedOnly: true, // default: true, if you want to use ata only, pass true
    },
    // computeBudgetConfig: {
    //   microLamports: COMPUTE_UNIT_PRICE,
    //   units: COMPUTE_UNIT_LIMIT,
    // },
  });

  // return transaction;
  // try {
  //   const latestBlockhash = await raydium.connection.getLatestBlockhash({
  //     commitment: 'finalized',
  //   });
  //   logger.info(`Send transaction attempt...`);

  //   const result = await executeAndConfirm(raydium.connection, transaction as VersionedTransaction, latestBlockhash);
  //   if (result.confirmed) {
  //     logger.info(
  //       {
  //         url: `https://solscan.io/tx/${result.signature}`,
  //       },
  //       `Confirmed transaction`,
  //     );
  //     return transaction;
  //   }
  //   logger.info(`failed!`);
  //   // return false;
  // } catch (error) {
  //   logger.error('Error confirming transaction');
  //   logger.info('1000ms waiting...');
  //   await sleep(1000);
  // }
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
