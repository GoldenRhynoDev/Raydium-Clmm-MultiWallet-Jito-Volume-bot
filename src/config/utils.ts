import {
  CLMM_PROGRAM_ID,
  Cluster,
  DEVNET_PROGRAM_ID,
  Raydium,
  parseTokenAccountResp,
} from '@raydium-io/raydium-sdk-v2';
import {
  Connection,
  PublicKey,
  Signer,
  Keypair,
  GetProgramAccountsFilter,
  sendAndConfirmTransaction,
  Transaction,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  getOrCreateAssociatedTokenAccount,
  createAssociatedTokenAccountInstruction,
  Account,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
  TokenInvalidMintError,
  TokenInvalidOwnerError,
} from '@solana/spl-token';
import bs58 from 'bs58';
import { mnemonicToSeedSync } from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import BN from 'bn.js';
import { logger } from './logger';
import { COMPUTE_UNIT_PRICE, COMPUTE_UNIT_LIMIT } from './constants';

import { executeAndConfirm } from '../clmm/Raydiumswap';
const VALID_PROGRAM_ID = new Set([CLMM_PROGRAM_ID.toBase58(), DEVNET_PROGRAM_ID.CLMM.toBase58()]);

export const initSdk = async (connection: Connection, owner: Keypair, cluster: Cluster): Promise<Raydium> => {
  const raydium = await Raydium.load({
    owner,
    connection,
    cluster,
    disableFeatureCheck: true,
    disableLoadToken: true,
    blockhashCommitment: 'finalized',
  });

  return raydium;
};

export async function sleep(ms: number) {
  return await new Promise((resolve) => setTimeout(resolve, ms));
}
export const isValidClmm = (id: string) => VALID_PROGRAM_ID.has(id);
export function getWallet(wallet: string): Keypair {
  // most likely someone pasted the private key in binary format
  if (wallet.startsWith('[')) {
    const raw = new Uint8Array(JSON.parse(wallet));
    return Keypair.fromSecretKey(raw);
  }

  // most likely someone pasted mnemonic
  if (wallet.split(' ').length > 1) {
    const seed = mnemonicToSeedSync(wallet, '');
    const path = `m/44'/501'/0'/0'`; // we assume it's first path
    return Keypair.fromSeed(derivePath(path, seed.toString('hex')).key);
  }

  // most likely someone pasted base58 encoded private key
  return Keypair.fromSecretKey(bs58.decode(wallet));
}
export async function getTokenAccountBalance(connection: Connection, wallet: string, mint_token: string) {
  try {
    const filters: GetProgramAccountsFilter[] = [
      {
        dataSize: 165, //size of account (bytes)
      },
      {
        memcmp: {
          offset: 32, //location of our query in the account (bytes)
          bytes: wallet, //our search criteria, a base58 encoded string
        },
      },
      //Add this search parameter
      {
        memcmp: {
          offset: 0, //number of bytes
          bytes: mint_token, //base58 encoded string
        },
      },
    ];

    const accounts = await connection.getParsedProgramAccounts(TOKEN_PROGRAM_ID, {
      filters: filters,
    });

    for (const account of accounts) {
      const parsedAccountInfo: any = account.account.data;
      const mintAddress: string = parsedAccountInfo['parsed']['info']['mint'];
      const tokenBalance: number = parseInt(parsedAccountInfo['parsed']['info']['tokenAmount']['amount']);

      if (tokenBalance) {
        return tokenBalance;
      }
    }
    return 0;
  } catch (error) {
    throw error;
  }
}
export const fetchWithTimeout = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const maxRetries = 300; // Number of retry attempts

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await sleep(200);
      let res = await Promise.race([
        fetch(input, init), // This fetch call returns a Promise<Response>
        // Timeout Promise that rejects after 5 seconds
        new Promise<Response>((_, reject) => setTimeout(() => reject(new Error('Request Timeout')), 5000)),
      ]);
      if (res.status === 429 /* Too many requests */) {
        throw Error();
      }
      return res;
    } catch (error) {
      if (attempt === maxRetries) {
        // If it's the last attempt, reject the promise
        break;
      }
      // Wait for a brief moment before retrying (optional)
      await new Promise((resolve) => setTimeout(resolve, 1000)); // Optionally wait for 1 second before retrying
    }
  }

  // If we exit the loop without returning, throw an error (this should not happen)
  throw new Error('Request Timeout');
};
export const getTokenDecimal = async (connection: Connection, tokenAddress: PublicKey): Promise<number> => {
  try {
    await sleep(200);
    const tokenSupply = await connection.getTokenSupply(tokenAddress);
    return tokenSupply.value.decimals;
  } catch (error) {
    logger.error('getTokenDecimal');
    throw error;
  }
};

export const getRandomNumber = (min: number, max: number): string => {
  const result = Math.random() * (max - min) + min;
  return result.toFixed(6);
};

export const getRandomRunTime = (min: number, max: number): number => {
  return Math.floor(Math.random() * (max - min + 1) + min);
};

export const getCoinBalance = async (connection: Connection, pubKey: PublicKey): Promise<number> => {
  try {
    await sleep(200);
    return await connection.getBalance(pubKey);
  } catch (error) {
    logger.error('getCoinBalance');
    throw error;
  }
};

export const getTokenBalance = async (connection: Connection, tokenAccount: Account): Promise<number> => {
  try {
    await sleep(200);
    const balance = await connection.getTokenAccountBalance(tokenAccount.address);
    return balance?.value?.uiAmount ? balance?.value?.uiAmount : 0;
  } catch (error) {
    throw error;
  }
};

export const getTokenAccount = async (
  connection: Connection,
  wallet: Signer,
  tokenAddress: PublicKey,
): Promise<Account> => {
  try {
    await sleep(200);
    const associatedToken = getAssociatedTokenAddressSync(new PublicKey(tokenAddress), wallet.publicKey);

    // This is the optimal logic, considering TX fee, client-side computation, RPC roundtrips and guaranteed idempotent.
    // Sadly we can't do this atomically.
    let account: Account;
    try {
      account = await getAccount(connection, associatedToken);
    } catch (error: unknown) {
      // TokenAccountNotFoundError can be possible if the associated address has already received some lamports,
      // becoming a system account. Assuming program derived addressing is safe, this is the only case for the
      // TokenInvalidAccountOwnerError in this code path.
      if (error instanceof TokenAccountNotFoundError || error instanceof TokenInvalidAccountOwnerError) {
        // As this isn't atomic, it's possible others can create associated accounts meanwhile.
        try {
          const latestBlockhash = await connection.getLatestBlockhash();
          const instructions = [
            createAssociatedTokenAccountInstruction(wallet.publicKey, associatedToken, wallet.publicKey, tokenAddress),
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: COMPUTE_UNIT_PRICE }),
            ComputeBudgetProgram.setComputeUnitLimit({ units: COMPUTE_UNIT_LIMIT }),
          ];
          const messageV0 = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: latestBlockhash.blockhash,
            instructions,
          }).compileToV0Message();

          const transaction = new VersionedTransaction(messageV0);
          transaction.sign([wallet]);

          let result1 = await executeAndConfirm(connection, transaction as VersionedTransaction, latestBlockhash);
          if (!result1.confirmed) {
            console.log(result1.error);
            process.exit(1);
          }
        } catch (error: unknown) {
          // Ignore all errors; for now there is no API-compatible way to selectively ignore the expected
          // instruction error if the associated account exists already.
        }

        // Now this should always succeed
        account = await getAccount(connection, associatedToken);
      } else {
        throw error;
      }
    }

    if (!account.mint.equals(tokenAddress)) throw new TokenInvalidMintError();
    if (!account.owner.equals(wallet.publicKey)) throw new TokenInvalidOwnerError();

    return account;
  } catch (error) {
    throw error;
  }
};
