import {IntermediaryConfig} from "../IntermediaryConfig";
import {NETWORK, TEST_NETWORK} from "@scure/btc-signer/utils";

const BitcoinNetworkParams = {
    "mainnet": NETWORK,
    "testnet": TEST_NETWORK,
    "testnet4": TEST_NETWORK,
    "regtest": {
        bech32: 'bcrt',
        pubKeyHash: 111,
        scriptHash: 196,
        wif: 239
    }
};

//Bitcoin
export const BITCOIN_NETWORK = BitcoinNetworkParams[IntermediaryConfig.BITCOIND.NETWORK];
export const BITCOIN_BLOCKTIME = BigInt(process.env.BITCOIN_BLOCKTIME);

//Swap safety
export const GRACE_PERIOD = BigInt(process.env.GRACE_PERIOD);
export const SAFETY_FACTOR = BigInt(process.env.SAFETY_FACTOR);
export const LN_SAFETY_FACTOR_OVERRIDE_PPM: bigint | null = process.env.LN_SAFETY_FACTOR_OVERRIDE_PPM==null
    ? null
    : BigInt(process.env.LN_SAFETY_FACTOR_OVERRIDE_PPM);
export const CHAIN_SEND_SAFETY_FACTOR = BigInt(process.env.CHAIN_SEND_SAFETY_FACTOR);

//Authorizations
export const AUTHORIZATION_TIMEOUT = parseInt(process.env.AUTHORIZATION_TIMEOUT);
export const REFUND_AUTHORIZATION_TIMEOUT = parseInt(process.env.REFUND_AUTHORIZATION_TIMEOUT ?? process.env.AUTHORIZATION_TIMEOUT);
