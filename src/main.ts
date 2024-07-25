import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
  Transaction,
  SystemProgram,
  VersionedTransaction,
  TransactionMessage,
} from '@solana/web3.js';
import BN from 'bn.js';
import fs from 'fs';
import {
  initSdk,
  getRandomRunTime,
  getRandomNumber,
  logger,
  getWallet,
  getCoinBalance,
  getTokenAccount,
  getTokenBalance,
  getTokenDecimal,
  JITO_FEE,
} from './config';
import {
  MIN_BUY_QUANTITY,
  MAX_BUY_QUANTITY,
  MIN_SELL_QUANTITY,
  MAX_SELL_QUANTITY,
  MIN_TIME,
  MAX_TIME,
  MIN_TRADE_WAIT,
  MAX_TRADE_WAIT,
  RPC_ENDPOINT,
  PROVIDER_PRIVATE_KEY,
  TOKEN_ADDRESS,
  SLIPPAGE,
  SEND_SOL_AMOUNT,
  NUMBER_OF_WALLETS,
  COMPUTE_UNIT_PRICE,
  COMPUTE_UNIT_LIMIT,
  TRANSACTION_COUNT_PER_BUNDLE,
  JITO_FEE_PAYER_PRIVATE_KEY,
} from './config';

import { getPoolInfo, getAmountOut, makeSwapTransaction, executeAndConfirm } from './amm/Raydiumswap';
import { NATIVE_MINT } from '@solana/spl-token';
import { executeAndConfirmByJito } from './jito-bundle';
import { sleep } from '@raydium-io/raydium-sdk-v2';
import bs58 from 'bs58';
import wallets from '../wallets.json';

let ammPoolInfomation: any;
let connection: Connection;
const providerWallet: Keypair = getWallet(PROVIDER_PRIVATE_KEY);
const jitoFeeWallet: Keypair = getWallet(JITO_FEE_PAYER_PRIVATE_KEY);
let tokenDecimal: number;
let transactionCountPerBundle: number = TRANSACTION_COUNT_PER_BUNDLE;

interface WALLET_STATUS {
  wallet: Keypair;
  id: number;
}

let walletArray: WALLET_STATUS[] = [];

let timeout = getRandomRunTime(MIN_TIME, MAX_TIME);
const main = async () => {
  logger.info(`Randomly Buying & Selling`);
  logger.info(`We will exit this process after ${timeout} miliseconds...`);
  connection = new Connection(RPC_ENDPOINT, 'confirmed');
  await createWalletsAndSendSol(connection);
  sleep(1000);
  await balance();
};

setInterval(() => {
  if (timeout === 0) {
    logger.info('process is exited\n\t Times up!');
    process.exit(1);
  }
  timeout--;
}, 1000);
const createWalletsAndSendSol = async (connection: Connection) => {
  tokenDecimal = await getTokenDecimal(connection, new PublicKey(TOKEN_ADDRESS));
  const walletBalance = await getCoinBalance(connection, providerWallet.publicKey);

  if (walletBalance / LAMPORTS_PER_SOL < SEND_SOL_AMOUNT * NUMBER_OF_WALLETS) {
    logger.error('Deposite sol into the provider wallet');
    process.exit(1);
  }
  let diffWalletCount = NUMBER_OF_WALLETS - wallets.length;
  if (diffWalletCount > 0) {
    let newWallets = [...wallets];
    for (diffWalletCount; diffWalletCount > 0; diffWalletCount--) {
      // Generating a new random Solana keypair
      const keypair = Keypair.generate();

      newWallets.push({
        publicKey: keypair.publicKey.toBase58(),
        secretKey: bs58.encode(keypair.secretKey),
      });
    }
    fs.writeFileSync('../wallets.json', JSON.stringify(newWallets, null, 1));
  }
  for (let i = 0; i < NUMBER_OF_WALLETS; i++) {
    const keypair: Keypair = getWallet(wallets[i].secretKey);
    walletArray = [...walletArray, { wallet: keypair, id: i }];
  }
  logger.info('Wallet Checking Now...');
  for (let i = 0; i < NUMBER_OF_WALLETS; i++) {
    logger.info(`${i + 1}. Checking ${walletArray[i].wallet.publicKey.toBase58()}`);
    let walletBalance = await getCoinBalance(connection, walletArray[i].wallet.publicKey);
    if (walletBalance < SEND_SOL_AMOUNT * LAMPORTS_PER_SOL) {
      let diffBalance = SEND_SOL_AMOUNT * LAMPORTS_PER_SOL - walletBalance;
      const latestBlockhash = await connection.getLatestBlockhash();
      const instructions = [
        SystemProgram.transfer({
          fromPubkey: providerWallet.publicKey,
          toPubkey: walletArray[i].wallet.publicKey,
          lamports: diffBalance,
        }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
      ];
      const messageV0 = new TransactionMessage({
        payerKey: providerWallet.publicKey,
        recentBlockhash: latestBlockhash.blockhash,
        instructions,
      }).compileToV0Message();

      const transaction = new VersionedTransaction(messageV0);
      transaction.sign([providerWallet]);
      let result;
      try {
        result = await executeAndConfirm(connection, transaction, latestBlockhash);
        if (result.confirmed) {
          logger.info(`transaction Sent: https://solscan.io/tx/${result.signature}`);
        } else {
          logger.error('Transaction sending is failed, retrying now');
          i--;
          continue;
        }
      } catch (error) {
        logger.error('Transaction sending is failed, retrying now');
        i--;
        continue;
      }
    }
    logger.info('This wallet has enough sol balance');
  }
};
const shuffle = (arr: Array<any>) => {
  return arr.sort((a, b) => {
    return Math.random() - 0.5;
  });
};
const balance = async () => {
  let bundleTransactions: VersionedTransaction[] = [];

  let walletAmount = walletArray.length;
  walletArray = [...shuffle(walletArray)];

  for (let i = 0; i < transactionCountPerBundle; i++) {
    //Reconfig transaction number per bundle
    if (transactionCountPerBundle > walletAmount) {
      transactionCountPerBundle = walletAmount;
      i--;
      continue;
    }
    if (transactionCountPerBundle === 0) {
      logger.info('Please send sol to child wallets.');
      process.exit(1);
    }

    let method = getRandomRunTime(1, 2);

    let tokenAmount = getRandomNumber(MIN_BUY_QUANTITY, MAX_BUY_QUANTITY);
    sleep(1000);

    let lampAmount = await getCoinBalance(connection, walletArray[i].wallet.publicKey);
    let tokenUnitAmount = Number(tokenAmount) * 10 ** tokenDecimal;
    if (!ammPoolInfomation) {
      sleep(1000);
      ammPoolInfomation = await getPoolInfo(connection, providerWallet);
    }
    let raydium = await initSdk(connection, walletArray[i].wallet, 'mainnet');
    // 1: buy   2: sell
    if (method === 1) {
      sleep(1000);
      const { amountOut } = await getAmountOut(
        raydium,
        ammPoolInfomation.poolInfo,
        ammPoolInfomation.rpcData,
        TOKEN_ADDRESS,
        new BN(tokenUnitAmount),
        SLIPPAGE / 100,
      );

      const solAmount = Number(amountOut) * (1 + SLIPPAGE / 100);

      if (new BN(lampAmount).lt(new BN(solAmount + 200000))) {
        //Check if it could sell
        sleep(1000);
        const tokenAccount = await getTokenAccount(connection, walletArray[i].wallet, new PublicKey(TOKEN_ADDRESS));
        sleep(1000);
        let token_in_wallet = await getTokenBalance(connection, tokenAccount);
        if (lampAmount / LAMPORTS_PER_SOL < 0.0002) {
          walletArray = [...walletArray.filter((item, index) => index !== i)];
          walletAmount--;
          i--;
          continue;
        } else {
          if (token_in_wallet > +tokenAmount) {
            sleep(1000);
            let transaction = await makeSwapTransaction(
              raydium,
              ammPoolInfomation.poolInfo,
              ammPoolInfomation.poolKeys,
              TOKEN_ADDRESS,
              new BN(tokenUnitAmount),
              new BN(1),
              'in',
            );
            bundleTransactions = [...bundleTransactions, transaction];
          } else {
            walletArray = [...walletArray.filter((item, index) => index !== i)];

            walletAmount--;
            i--;
            continue;
          }
        }
      } else {
        sleep(1000);
        let transaction = await makeSwapTransaction(
          raydium,
          ammPoolInfomation.poolInfo,
          ammPoolInfomation.poolKeys,
          NATIVE_MINT.toBase58(),
          new BN(solAmount),
          new BN(1),
          'in',
        );
        bundleTransactions = [...bundleTransactions, transaction];
      }
    } else {
      sleep(1000);
      const tokenAccount = await getTokenAccount(connection, walletArray[i].wallet, new PublicKey(TOKEN_ADDRESS));
      sleep(1000);
      let token_in_wallet = await getTokenBalance(connection, tokenAccount);

      if (lampAmount / LAMPORTS_PER_SOL < 0.0002) {
        walletArray = [...walletArray.filter((item, index) => index !== i)];

        walletAmount--;
        i--;
      } else {
        if (token_in_wallet < +tokenAmount) {
          sleep(1000);
          const { amountOut } = await getAmountOut(
            raydium,
            ammPoolInfomation.poolInfo,
            ammPoolInfomation.rpcData,
            TOKEN_ADDRESS,
            new BN(tokenUnitAmount),
            SLIPPAGE / 100,
          );

          const solAmount = Number(amountOut) * (1 + SLIPPAGE / 100);
          if (new BN(lampAmount).lt(new BN(solAmount + 200000))) {
            walletArray = [...walletArray.filter((item, index) => index !== i)];

            walletAmount--;
            i--;
            continue;
          } else {
            sleep(1000);
            let transaction = await makeSwapTransaction(
              raydium,
              ammPoolInfomation.poolInfo,
              ammPoolInfomation.poolKeys,
              NATIVE_MINT.toBase58(),
              new BN(solAmount),
              new BN(1),
              'in',
            );
            bundleTransactions = [...bundleTransactions, transaction];
          }
        } else {
          sleep(1000);

          let transaction = await makeSwapTransaction(
            raydium,
            ammPoolInfomation.poolInfo,
            ammPoolInfomation.poolKeys,
            TOKEN_ADDRESS,
            new BN(tokenUnitAmount),
            new BN(1),
            'in',
          );
          bundleTransactions = [...bundleTransactions, transaction];
        }
      }
    }
  }

  if (transactionCountPerBundle !== TRANSACTION_COUNT_PER_BUNDLE) transactionCountPerBundle++;

  const latestBlockhash = await connection.getLatestBlockhash();
  sleep(1000);
  const result = await executeAndConfirmByJito(
    connection,
    jitoFeeWallet,
    JITO_FEE,
    transactionCountPerBundle,
    bundleTransactions,
    latestBlockhash,
  );
  if (result.confirmed) {
    logger.info(`https://explorer.jito.wtf/bundle/${result.signature}`);
  }

  const wtime = getRandomRunTime(MIN_TRADE_WAIT, MAX_TRADE_WAIT);
  logger.info(`waiting ${wtime} miliseconds...`);
  setTimeout(balance, wtime);
};

main();
