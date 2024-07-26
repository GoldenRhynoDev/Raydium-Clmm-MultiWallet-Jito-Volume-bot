import {
  CLMM_PROGRAM_ID,
  Cluster,
  DEVNET_PROGRAM_ID,
  Raydium,
  parseTokenAccountResp,
} from '@raydium-io/raydium-sdk-v2';

import { Connection, PublicKey, Signer, Keypair, GetProgramAccountsFilter } from '@solana/web3.js';
import { getOrCreateAssociatedTokenAccount, Account, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { mnemonicToSeedSync } from 'bip39';
import { derivePath } from 'ed25519-hd-key';
import BN from 'bn.js';
import { logger } from './logger';

const VALID_PROGRAM_ID = new Set([CLMM_PROGRAM_ID.toBase58(), DEVNET_PROGRAM_ID.CLMM.toBase58()]);

export const isValidClmm = (id: string) => VALID_PROGRAM_ID.has(id);

export const getTokenDecimal = async (connection: Connection, tokenAddress: PublicKey): Promise<number> => {
  try {
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
    return await connection.getBalance(pubKey);
  } catch (error) {
    logger.error('getCoinBalance');
    throw error;
  }
};

export const getTokenBalance = async (
  connection: Connection,
  tokenAccount: Account,
  walletAddress: PublicKey,
): Promise<number> => {
  try {
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
    return await getOrCreateAssociatedTokenAccount(connection, wallet, tokenAddress, wallet.publicKey);
  } catch (error) {
    throw error;
  }
};

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

export const fetchTokenAccountData = async (connection: Connection, owner: Keypair) => {
  const solAccountResp = await connection.getAccountInfo(owner.publicKey);
  const tokenAccountResp = await connection.getTokenAccountsByOwner(owner.publicKey, { programId: TOKEN_PROGRAM_ID });
  const token2022Req = await connection.getTokenAccountsByOwner(owner.publicKey, { programId: TOKEN_2022_PROGRAM_ID });
  const tokenAccountData = parseTokenAccountResp({
    owner: owner.publicKey,
    solAccountResp,
    tokenAccountResp: {
      context: tokenAccountResp.context,
      value: [...tokenAccountResp.value, ...token2022Req.value],
    },
  });
  return tokenAccountData;
};

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
export const sleep = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

export async function getTokenAccountBalance(connection: Connection, wallet: string, mint_token: string) {
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

    console.log(`Account: ${account.pubkey.toString()} - Mint: ${mintAddress} - Balance: ${tokenBalance}`);

    if (tokenBalance) {
      return tokenBalance;
    }
  }
  return 0;
}
