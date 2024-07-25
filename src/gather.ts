import { TOKEN_ADDRESS, GATHER_WALLET_ADDRESS, COMPUTE_UNIT_LIMIT, COMPUTE_UNIT_PRICE, RPC_ENDPOINT } from './config';
import wallets from '../wallets.json';
import { getWallet, getTokenAccountBalance, getCoinBalance } from './config';
import { logger } from './config';
import {
  Connection,
  PublicKey,
  ComputeBudgetProgram,
  Transaction,
  sendAndConfirmTransaction,
  SystemProgram,
  Keypair,
  VersionedTransaction,
  TransactionMessage,
} from '@solana/web3.js';
import { executeAndConfirm } from './amm/Raydiumswap';
import { unpackMint, getOrCreateAssociatedTokenAccount, createTransferInstruction } from '@solana/spl-token';
import bs58 from 'bs58';
let connection: Connection = new Connection(RPC_ENDPOINT, 'confirmed');
export const wallet_2_gather_keypair = Keypair.fromSecretKey(new Uint8Array(bs58.decode(GATHER_WALLET_ADDRESS)));
const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
  units: COMPUTE_UNIT_LIMIT,
});

const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
  microLamports: COMPUTE_UNIT_PRICE,
});
async function gather() {
  const toTokenAccount = await getOrCreateAssociatedTokenAccount(
    connection,
    wallet_2_gather_keypair,
    new PublicKey(TOKEN_ADDRESS),
    wallet_2_gather_keypair.publicKey,
  );
  for (let i = 0; i < wallets.length; i++) {
    try {
      let fromWallet = getWallet('[' + wallets[i] + ']');
      let fromTokenAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        fromWallet,
        new PublicKey(TOKEN_ADDRESS),
        fromWallet.publicKey,
      );
      let tokenAmount = await getTokenAccountBalance(connection, fromWallet.publicKey.toBase58(), TOKEN_ADDRESS);
      if (tokenAmount != 0) {
        const latestBlockhash = await connection.getLatestBlockhash();
        const instructions = [
          createTransferInstruction(
            fromTokenAccount.address,
            toTokenAccount.address,
            fromWallet.publicKey,
            tokenAmount,
          ),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
        ];
        const messageV0 = new TransactionMessage({
          payerKey: fromWallet.publicKey,
          recentBlockhash: latestBlockhash.blockhash,
          instructions,
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([fromWallet]);
        let result1 = await executeAndConfirm(connection, transaction, latestBlockhash);
        if (result1.confirmed) {
          console.log('\t\tToken Sent! =>', `https://solscan.io/tx/${result1.signature}`);
        }
      }
      const walletBalance = await getCoinBalance(connection, fromWallet.publicKey);

      if (walletBalance < 1000000) {
        console.log("\t\tThis account don't have enough coin balance!!");
      } else {
        const latestBlockhash = await connection.getLatestBlockhash();
        const instructions = [
          SystemProgram.transfer({
            fromPubkey: fromWallet.publicKey,
            toPubkey: wallet_2_gather_keypair.publicKey,
            lamports: walletBalance - 1000000,
          }),
          ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE }),
          ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
        ];
        const messageV0 = new TransactionMessage({
          payerKey: fromWallet.publicKey,
          recentBlockhash: latestBlockhash.blockhash,
          instructions,
        }).compileToV0Message();

        const transaction = new VersionedTransaction(messageV0);
        transaction.sign([fromWallet]);
        let result2 = await executeAndConfirm(connection, transaction, latestBlockhash);
        if (result2.confirmed) {
          console.log('\t\tSol Sent! =>', `https://solscan.io/tx/${result2.signature}`);
        }
      }
    } catch (e: unknown) {
      logger.info(`[SWAP - SELL - ERROR] ${e}`);
    }
  }
}
gather();
