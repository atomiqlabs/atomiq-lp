import * as bitcoin from "bitcoinjs-lib";
import {IntermediaryConfig} from "../IntermediaryConfig";

//Bitcoin
export const BITCOIN_NETWORK = IntermediaryConfig.BITCOIND.NETWORK==="mainnet" ? bitcoin.networks.bitcoin : bitcoin.networks.testnet;
export const BITCOIN_BLOCKTIME = BigInt(process.env.BITCOIN_BLOCKTIME);

//Swap safety
export const GRACE_PERIOD = BigInt(process.env.GRACE_PERIOD);
export const SAFETY_FACTOR = BigInt(process.env.SAFETY_FACTOR);
export const CHAIN_SEND_SAFETY_FACTOR = BigInt(process.env.CHAIN_SEND_SAFETY_FACTOR);

//Authorizations
export const AUTHORIZATION_TIMEOUT = parseInt(process.env.AUTHORIZATION_TIMEOUT);
export const REFUND_AUTHORIZATION_TIMEOUT = parseInt(process.env.REFUND_AUTHORIZATION_TIMEOUT ?? process.env.AUTHORIZATION_TIMEOUT);
