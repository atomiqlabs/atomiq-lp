import {PublicKey} from "@solana/web3.js";
import * as BN from "bn.js";
import * as bitcoin from "bitcoinjs-lib";

//Bitcoin
export const BITCOIN_NETWORK = bitcoin.networks.testnet;
export const BITCOIN_BLOCKTIME = new BN(10*60);

//Swap safety
export const GRACE_PERIOD = new BN(60*60); //1 hour
export const SAFETY_FACTOR = new BN(2);
export const CHAIN_SEND_SAFETY_FACTOR = new BN(2);

//On-chain fee multiplier
export const NETWORK_FEE_MULTIPLIER_PPM = new BN(1500000);

//Solana
export const MAX_SOL_SKEW = 10*60; //How long to wait to refund back the order after its expiry
export const WBTC_ADDRESS = new PublicKey(process.env.WBTC_ADDRESS);

//Authorizations
export const AUTHORIZATION_TIMEOUT = 10*60;

//LN fees
export const LN_BASE_FEE = new BN(10);
export const LN_FEE_PPM = new BN(3000);

export const LN_MIN = new BN(1000);
export const LN_MAX = new BN(1000000);

//On-chain fees
export const CHAIN_BASE_FEE = new BN(50);
export const CHAIN_FEE_PPM = new BN(3000);

export const CHAIN_MIN = new BN(10000);
export const CHAIN_MAX = new BN(1000000);

//Swap program
export const STATE_SEED = "state";
export const VAULT_SEED = "vault";
export const USER_VAULT_SEED = "uservault";
export const AUTHORITY_SEED = "authority";