import {BitcoinRpc, ChainSwapType} from "@atomiqlabs/base";
import {
    FromBtcLnSwapAbs,
    FromBtcLnSwapState,
    FromBtcSwapAbs,
    FromBtcSwapState, IBitcoinWallet, ILightningWallet, ISpvVaultSigner,
    ISwapPrice, MultichainData,
    PluginManager, SpvVault, SpvVaultState, SpvVaultSwap, SpvVaultSwapState,
    SwapHandlerType,
    ToBtcLnSwapAbs,
    ToBtcLnSwapState,
    ToBtcSwapAbs,
    ToBtcSwapState
} from "@atomiqlabs/lp-lib";
import {IntermediaryRunner} from "./IntermediaryRunner";
import {
    cmdEnumParser,
    cmdNumberParser,
    cmdStringParser,
    CommandHandler,
    createCommand,
    RpcConfig,
    TcpCliConfig
} from "@atomiqlabs/server-base";
import {fromDecimal, toDecimal} from "../Utils";
import {allowedChains, IntermediaryConfig} from "../IntermediaryConfig";
import {Registry} from "../Registry";
import {bigIntSorter} from "@atomiqlabs/lp-lib/dist/utils/Utils";

function sortVaults(vaults: SpvVault[]) {
    vaults.sort(
        (a, b) => bigIntSorter(a.data.getVaultId(), b.data.getVaultId())
    );
}

export class IntermediaryRunnerWrapper extends IntermediaryRunner {

    cmdHandler: CommandHandler;
    lpRegistry: Registry;
    addressesToTokens: {
        [chainId: string]: {
            [address: string]: {
                ticker: string,
                decimals: number
            }
        }
    };

    fromReadableToken(txt: string) {
        const arr = txt.split("-");
        if(arr.length<2) throw new Error("Unknown token, use format <chain>-<ticker>");
        return {ticker: txt.substring(arr[0].length+1), chainId: arr[0]};
    }

    toReadableToken(chainId: string, ticker: string) {
        return chainId+"-"+ticker;
    }

    constructor(
        directory: string,
        multichainData: MultichainData,
        tokens: {
            [ticker: string]: {
                chains: {
                    [chainIdentifier: string] : {
                        address: string,
                        decimals: number
                    }
                },
                pricing: string,
                disabled?: boolean
            }
        },
        prices: ISwapPrice<any>,
        bitcoinRpc: BitcoinRpc<any>,
        bitcoinWallet: IBitcoinWallet,
        lightningWallet: ILightningWallet,
        spvVaultSigner: ISpvVaultSigner
    ) {
        super(directory, multichainData, tokens, prices, bitcoinRpc, bitcoinWallet, lightningWallet, spvVaultSigner);
        this.lpRegistry = new Registry(directory+"/lpRegistration.txt");
        this.addressesToTokens = {};
        const tokenTickers = [];
        for(let ticker in this.tokens) {
            for(let chainId in this.tokens[ticker].chains) {
                if(this.addressesToTokens[chainId]==null) this.addressesToTokens[chainId] = {};
                const tokenData = this.tokens[ticker].chains[chainId];
                this.addressesToTokens[chainId][tokenData.address] = {
                    decimals: tokenData.decimals,
                    ticker
                };
                tokenTickers.push(this.toReadableToken(chainId, ticker));
            }
        }
        const commands = [
            createCommand(
                "status",
                "Fetches the current status of the bitcoin RPC, LND gRPC & intermediary application",
                {
                    args: {},
                    parser: async (args) => {
                        const smartChains: any = {};
                        for(let chainId in this.multichainData.chains) {
                            const {chainInterface, signer} = this.multichainData.chains[chainId];
                            const nativeTokenAddress = chainInterface.getNativeCurrencyAddress();
                            const {decimals, ticker} = this.addressesToTokens[chainId][nativeTokenAddress.toString()];
                            let nativeTokenBalance: bigint;
                            try {
                                nativeTokenBalance = await chainInterface.getBalance(signer.getAddress(), nativeTokenAddress);
                            } catch (e) {
                                console.error(e);
                            }
                            smartChains[chainId] = {
                                rpcStatus: nativeTokenBalance != null ? "ready" : "offline",
                                funds: nativeTokenBalance != null ? toDecimal(nativeTokenBalance, decimals) : null,
                                ticker: ticker,
                                hasEnoughFunds: nativeTokenBalance != null ? nativeTokenBalance > 100000000n : false
                            };
                        }

                        let bitcoinRpc = null;
                        if(this.bitcoinRpc!=null) {
                            const btcRpcStatus = await this.bitcoinRpc.getSyncInfo().catch(e => null);
                            bitcoinRpc = {
                                status: btcRpcStatus == null ? "offline" : btcRpcStatus.ibd ? "verifying blockchain" : "ready",
                                verificationProgress: btcRpcStatus?.verificationProgress ? 
                                    (btcRpcStatus.verificationProgress * 100).toFixed(4) + "%" : null,
                                syncedHeaders: btcRpcStatus?.headers || null,
                                syncedBlocks: btcRpcStatus?.blocks || null
                            };
                        }

                        let bitcoinWallet = null;
                        if(this.bitcoinWallet!=null) {
                            bitcoinWallet = {
                                status: this.bitcoinWallet.getStatus(),
                                ...this.bitcoinWallet.getStatusInfo()
                            };
                        }

                        let lightningWallet = null;
                        if(this.lightningWallet!=null) {
                            lightningWallet = {
                                status: this.lightningWallet.getStatus(),
                                nodePubkey: this.lightningWallet.isReady() ? await this.lightningWallet.getIdentityPublicKey() : null,
                                ...this.lightningWallet.getStatusInfo()
                            };
                        }

                        return {
                            smartChains,
                            bitcoinRpc,
                            bitcoinWallet,
                            lightningWallet,
                            lpNodeStatus: this.initState
                        };
                    }
                }
            ),
            createCommand(
                "getaddress",
                "Gets the SmartChains & Bitcoin address of the node",
                {
                    args: {},
                    parser: async (args) => {
                        const addresses: any = {};
                        for(let chainId in this.multichainData.chains) {
                            const {signer} = this.multichainData.chains[chainId];
                            addresses[chainId] = signer.getAddress();
                        }

                        if(this.bitcoinWallet!=null) {
                            if(!this.bitcoinWallet.isReady()) {
                                addresses.bitcoin = { error: "bitcoin wallet not ready" };
                            } else {
                                addresses.bitcoin = await this.bitcoinWallet.getAddress();
                            }
                        }
                        
                        return { addresses };
                    }
                }
            ),
            createCommand(
                "getbalance",
                "Gets the balances of the node",
                {
                    args: {},
                    parser: async (args) => {
                        const nonTradingWalletBalances: any = {};
                        for(let chainId in this.addressesToTokens) {
                            const {swapContract, signer} = this.multichainData.chains[chainId];
                            nonTradingWalletBalances[chainId] = {};
                            for(let tokenAddress in this.addressesToTokens[chainId]) {
                                const tokenData = this.addressesToTokens[chainId][tokenAddress];
                                const tokenBalance = await swapContract.getBalance(signer.getAddress(), tokenAddress, false);
                                nonTradingWalletBalances[chainId][tokenData.ticker] = {
                                    balance: toDecimal(tokenBalance, tokenData.decimals),
                                    decimals: tokenData.decimals
                                };
                            }
                        }

                        const tradingVaultBalances: any = {};
                        for(let chainId in this.addressesToTokens) {
                            const {swapContract, signer} = this.multichainData.chains[chainId];
                            tradingVaultBalances[chainId] = {};
                            for(let tokenAddress in this.addressesToTokens[chainId]) {
                                const tokenData = this.addressesToTokens[chainId][tokenAddress];
                                const tokenBalance = await swapContract.getBalance(signer.getAddress(),tokenAddress, true);
                                tradingVaultBalances[chainId][tokenData.ticker] = {
                                    balance: toDecimal(tokenBalance || 0n, tokenData.decimals),
                                    decimals: tokenData.decimals
                                };
                            }
                        }

                        let tradingBitcoinBalance = null;
                        if(this.bitcoinWallet!=null) {
                            if(!this.bitcoinWallet.isReady()) {
                                tradingBitcoinBalance = { error: "bitcoin wallet not ready" };
                            } else {
                                const balances = await this.bitcoinWallet.getBalance();
                                tradingBitcoinBalance = {
                                    confirmed: toDecimal(BigInt(balances.confirmed), 8),
                                    unconfirmed: toDecimal(BigInt(balances.unconfirmed), 8),
                                    decimals: 8
                                };
                            }
                        }

                        let tradingLightningBalance = null;
                        if(this.lightningWallet!=null) {
                            if(!this.lightningWallet.isReady()) {
                                tradingLightningBalance = { error: "lightning wallet not ready" };
                            } else {
                                const channelBalance = await this.lightningWallet.getLightningBalance();
                                tradingLightningBalance = {
                                    localBalance: toDecimal(BigInt(channelBalance.localBalance), 8),
                                    unsettledBalance: toDecimal(BigInt(channelBalance.unsettledBalance), 8),
                                    decimals: 8
                                };
                            }
                        }

                        return {
                            nonTradingWalletBalances,
                            tradingVaultBalances,
                            tradingBitcoinBalance,
                            tradingLightningBalance
                        };
                    }
                }
            ),
            createCommand(
                "transfer",
                "Transfer wallet balance to an external address",
                {
                    args: {
                        asset: {
                            base: true,
                            description: "Asset to transfer: "+tokenTickers.concat(this.bitcoinWallet!=null ? ["BTC"] : []).join(", "),
                            parser: cmdEnumParser<string>(tokenTickers.concat(this.bitcoinWallet!=null ? ["BTC"] : []))
                        },
                        address: {
                            base: true,
                            description: "Destination address",
                            parser: cmdStringParser()
                        },
                        amount: {
                            base: true,
                            description: "Amount of the currency to send",
                            parser: cmdStringParser(1)
                        },
                        feeRate: {
                            base: false,
                            description: "Fee rate: sats/vB for BTC",
                            parser: cmdNumberParser(false, 1, null, true)
                        }
                    },
                    parser: async (args, sendLine) => {
                        if(args.asset==="BTC") {
                            if(!this.bitcoinWallet.isReady()) throw new Error("Bitcoin wallet not ready yet! Monitor the status with the 'status' command");
                            const amtBN = fromDecimal(args.amount, 8);

                            const res = await this.bitcoinWallet.getSignedTransaction(args.address, Number(amtBN), args.feeRate);
                            await this.bitcoinWallet.sendRawTransaction(res.raw);

                            return {
                                success: true,
                                message: "Transaction sent",
                                txId: res.txId
                            };
                        }

                        const {chainId, ticker} = this.fromReadableToken(args.asset);

                        const {chainInterface, signer} = this.multichainData.chains[chainId];
                        const tokenData = this.tokens[ticker].chains[chainId];
                        const amtBN = fromDecimal(args.amount, tokenData.decimals);

                        const txns = await chainInterface.txsTransfer(signer.getAddress(), tokenData.address, amtBN, args.address);
                        const txIds = await chainInterface.sendAndConfirm(signer, txns, true, null, null, (txId: string) => {
                            sendLine("Transaction sent, signature: "+txId+" waiting for confirmation...");
                            return Promise.resolve();
                        });
                        return {
                            success: true,
                            message: "Transfer transaction confirmed",
                            txId: txIds[txIds.length-1]
                        };
                    }
                }
            ),
            createCommand(
                "deposit",
                "Deposits smartchain wallet balance to an LP Vault",
                {
                    args: {
                        asset: {
                            base: true,
                            description: "Asset to transfer: "+tokenTickers.join(", "),
                            parser: cmdEnumParser<string>(tokenTickers)
                        },
                        amount: {
                            base: true,
                            description: "Amount of the currency to deposit",
                            parser: cmdStringParser(1)
                        }
                    },
                    parser: async (args, sendLine) => {
                        const {chainId, ticker} = this.fromReadableToken(args.asset);

                        const {chainInterface, swapContract, signer} = this.multichainData.chains[chainId];
                        const tokenData = this.tokens[ticker].chains[chainId];

                        const amtBN = fromDecimal(args.amount, tokenData.decimals);

                        const txns = await swapContract.txsDeposit(signer.getAddress(), tokenData.address, amtBN);
                        const txIds = await chainInterface.sendAndConfirm(signer, txns, true, null, null, (txId: string) => {
                            sendLine("Transaction sent, signature: "+txId+" waiting for confirmation...");
                            return Promise.resolve();
                        });
                        return {
                            success: true,
                            message: "Deposit transaction confirmed",
                            txId: txIds[txIds.length-1]
                        };
                    }
                }
            ),
            createCommand(
                "withdraw",
                "Withdraw LP Vault balance to node's SmartChain wallet",
                {
                    args: {
                        asset: {
                            base: true,
                            description: "Asset to withdraw: "+tokenTickers.join(", "),
                            parser: cmdEnumParser<string>(tokenTickers)
                        },
                        amount: {
                            base: true,
                            description: "Amount of the currency to withdraw",
                            parser: cmdStringParser(1)
                        }
                    },
                    parser: async (args, sendLine) => {
                        const {chainId, ticker} = this.fromReadableToken(args.asset);

                        const {chainInterface, swapContract, signer} = this.multichainData.chains[chainId];
                        const tokenData = this.tokens[ticker].chains[chainId];
                        console.log(typeof(args.amount), args.amount);
                        const amtBN = fromDecimal(args.amount, tokenData.decimals);

                        const txns = await swapContract.txsWithdraw(signer.getAddress(), tokenData.address, amtBN);
                        const txIds = await chainInterface.sendAndConfirm(signer, txns, true, null, null, (txId: string) => {
                            sendLine("Transaction sent, signature: "+txId+" waiting for confirmation...");
                            return Promise.resolve();
                        });
                        return {
                            success: true,
                            message: "Withdrawal transaction confirmed",
                            txId: txIds[txIds.length-1]
                        };
                    }
                }
            ),
            createCommand(
                "getreputation",
                "Checks the LP node's reputation stats",
                {
                    args: {},
                    parser: async (args, sendLine) => {
                        const reputation: any = {};
                        for(let chainId in this.addressesToTokens) {
                            const {swapContract, signer} = this.multichainData.chains[chainId];
                            reputation[chainId] = {};
                            for(let tokenAddress in this.addressesToTokens[chainId]) {
                                const {ticker, decimals} = this.addressesToTokens[chainId][tokenAddress];

                                const reputationData = await swapContract.getIntermediaryReputation(signer.getAddress(), tokenAddress);
                                if(reputationData==null) {
                                    reputation[chainId][ticker] = null;
                                    continue;
                                }
                                
                                const lnData = reputationData[ChainSwapType.HTLC];
                                const onChainData = reputationData[ChainSwapType.CHAIN_NONCED];
                                
                                reputation[chainId][ticker] = {
                                    lightning: {
                                        successes: {
                                            volume: toDecimal(lnData.successVolume, decimals),
                                            count: lnData.successCount.toString(10)
                                        },
                                        fails: {
                                            volume: toDecimal(lnData.failVolume, decimals),
                                            count: lnData.failCount.toString(10)
                                        },
                                        coopCloses: {
                                            volume: toDecimal(lnData.coopCloseVolume, decimals),
                                            count: lnData.coopCloseCount.toString(10)
                                        }
                                    },
                                    onChain: {
                                        successes: {
                                            volume: toDecimal(onChainData.successVolume, decimals),
                                            count: onChainData.successCount.toString(10)
                                        },
                                        fails: {
                                            volume: toDecimal(onChainData.failVolume, decimals),
                                            count: onChainData.failCount.toString(10)
                                        },
                                        coopCloses: {
                                            volume: toDecimal(onChainData.coopCloseVolume, decimals),
                                            count: onChainData.coopCloseCount.toString(10)
                                        }
                                    }
                                };
                            }
                        }
                        return { reputation };
                    }
                }
            ),
            createCommand(
                "plugins",
                "Shows the list of loaded plugins",
                {
                    args: {},
                    parser: async (args, sendLine) => {
                        const plugins: any = {};
                        for(let [name, plugin] of PluginManager.plugins.entries()) {
                            plugins[name] = plugin.description || "No description";
                        }
                        return { plugins };
                    }
                }
            ),
            createCommand(
                "geturl",
                "Returns the URL of the node (only works when SSL_AUTO mode is used)",
                {
                    args: {},
                    parser: async (args, sendLine) => {
                        if(IntermediaryConfig.SSL_AUTO==null) throw new Error("Node is not using SSL_AUTO mode for certificate provision!");
                        if(this.sslAutoUrl==null) throw new Error("Url not generated yet (node is still syncing?)");
                        return { url: this.sslAutoUrl };
                    }
                }
            ),
            createCommand(
                "register",
                "Registers the URL of the node to the public LP node registry (only works when SSL_AUTO mode is used)",
                {
                    args: {
                        mail: {
                            base: true,
                            description: "E-mail to use for the LP registration, if there is something wrong with your node we will contact you here (can be empty - \"\" to opt-out)!",
                            parser: cmdStringParser()
                        }
                    },
                    parser: async (args, sendLine) => {
                        if(IntermediaryConfig.SSL_AUTO==null) throw new Error("Node is not using SSL_AUTO mode for certificate provision!");
                        if(this.sslAutoUrl==null) throw new Error("Url not generated yet (node is still syncing?)");
                        const isRegistering = await this.lpRegistry.isRegistering();
                        if(isRegistering) {
                            const {status, url} = await this.lpRegistry.getRegistrationStatus();
                            return {
                                success: true,
                                status: "checking",
                                message: "LP registration status: " + status,
                                githubPR: url
                            };
                        } else {
                            const network = IntermediaryConfig.BITCOIND.NETWORK;
                            if(network==="regtest") {
                                return {
                                    success: false,
                                    message: "Not supported on regtest!"
                                };
                            }
                            const url = await this.lpRegistry.register(network, this.sslAutoUrl, args.mail==="" ? null : args.mail);
                            return {
                                success: true,
                                status: "created",
                                message: "LP registration request created",
                                url: url
                            };
                        }
                    }
                }
            ),
            createCommand(
                "listswaps",
                "Lists all swaps in progress",
                {
                    args: {
                        quotes: {
                            base: false,
                            description: "Whether to also show issued quotes (not yet committed to swaps) - 0/1",
                            parser: cmdNumberParser(false, 0, 1, true)
                        }
                    },
                    parser: async (args, sendLine) => {
                        const swaps: any[] = [];
                        for(let swapHandler of this.swapHandlers) {
                            for(let {obj: _swap} of await swapHandler.storageManager.query([])) {
                                const tokenData = this.addressesToTokens[_swap.chainIdentifier][_swap.getToken().toString()];
                                if(_swap.type===SwapHandlerType.TO_BTC) {
                                    const swap = _swap as ToBtcSwapAbs;
                                    if(args.quotes!==1 && swap.state===ToBtcSwapState.SAVED) continue;
                                    const swapInfo: any = {
                                        type: "TO_BTC",
                                        fromAmount: toDecimal(swap.data.getAmount(), tokenData.decimals),
                                        fromToken: tokenData.ticker,
                                        toAmount: toDecimal(swap.amount, 8),
                                        toToken: "BTC",
                                        identifierHash: _swap.getIdentifierHash(),
                                        escrowHash: _swap.getEscrowHash(),
                                        claimHash: _swap.getClaimHash(),
                                        state: ToBtcSwapState[swap.state],
                                        swapFee: toDecimal(swap.swapFee, 8),
                                        quotedNetworkFee: toDecimal(swap.quotedNetworkFee, 8),
                                        address: swap.address
                                    };
                                    if(swap.txId!=null) {
                                        swapInfo.txId = swap.txId;
                                        swapInfo.realNetworkFee = toDecimal(swap.realNetworkFee, 8);
                                    }
                                    swaps.push(swapInfo);
                                }
                                if(_swap.type===SwapHandlerType.TO_BTCLN) {
                                    const swap = _swap as ToBtcLnSwapAbs;
                                    if(args.quotes!==1 && swap.state===ToBtcLnSwapState.SAVED) continue;
                                    const swapInfo: any = {
                                        type: "TO_BTCLN",
                                        fromAmount: toDecimal(swap.data.getAmount(), tokenData.decimals),
                                        fromToken: tokenData.ticker,
                                        toAmount: toDecimal(swap.getOutputAmount(), 8),
                                        toToken: "BTC-LN",
                                        identifierHash: _swap.getIdentifierHash(),
                                        escrowHash: _swap.getEscrowHash(),
                                        claimHash: _swap.getClaimHash(),
                                        state: ToBtcLnSwapState[swap.state],
                                        swapFee: toDecimal(swap.swapFee, 8),
                                        quotedNetworkFee: toDecimal(swap.quotedNetworkFee, 8),
                                        invoice: swap.pr
                                    };
                                    if(swap.realNetworkFee!=null) {
                                        swapInfo.realNetworkFee = toDecimal(swap.realNetworkFee, 8);
                                    }
                                    swaps.push(swapInfo);
                                }
                                if(_swap.type===SwapHandlerType.FROM_BTC) {
                                    const swap = _swap as FromBtcSwapAbs;
                                    if(args.quotes!==1 && swap.state===FromBtcSwapState.CREATED) continue;
                                    const swapInfo: any = {
                                        type: "FROM_BTC",
                                        fromAmount: toDecimal(swap.amount, 8),
                                        fromToken: "BTC",
                                        toAmount: toDecimal(swap.data.getAmount(), tokenData.decimals),
                                        toToken: tokenData.ticker,
                                        identifierHash: _swap.getIdentifierHash(),
                                        escrowHash: _swap.getEscrowHash(),
                                        claimHash: _swap.getClaimHash(),
                                        state: FromBtcSwapState[swap.state],
                                        swapFee: toDecimal(swap.swapFee, 8),
                                        address: swap.address
                                    };
                                    swaps.push(swapInfo);
                                }
                                if(_swap.type===SwapHandlerType.FROM_BTC_SPV) {
                                    const swap = _swap as SpvVaultSwap;

                                    const gasTokenData = this.addressesToTokens[swap.chainIdentifier][swap.getGasToken().toString()];

                                    if(args.quotes!==1 && swap.state===SpvVaultSwapState.CREATED) continue;
                                    const swapInfo: any = {
                                        type: "FROM_BTC_SPV",
                                        fromAmount: toDecimal(swap.amountBtc, 8),
                                        fromToken: "BTC",
                                        toAmount: toDecimal(swap.getOutputAmount(), tokenData.decimals),
                                        toToken: tokenData.ticker,
                                        toGasAmount: toDecimal(swap.getOutputGasAmount(), gasTokenData.decimals),
                                        toGasToken: gasTokenData.ticker,
                                        identifierHash: swap.getIdentifierHash(),
                                        btcTxId: swap.btcTxId,
                                        spvVaultId: swap.vaultId.toString(10),
                                        state: SpvVaultSwapState[swap.state],
                                        totalFee: toDecimal(swap.getSwapFee().inInputToken, 8),
                                        swapFee: toDecimal(swap.getTokenSwapFee().inInputToken, 8),
                                        gasSwapFee: toDecimal(swap.getGasSwapFee().inInputToken, 8),
                                        address: swap.btcAddress
                                    };
                                    swaps.push(swapInfo);
                                }
                                if(_swap.type===SwapHandlerType.FROM_BTCLN) {
                                    const swap = _swap as FromBtcLnSwapAbs;
                                    if(args.quotes!==1 && swap.state===FromBtcLnSwapState.CREATED) continue;
                                    const swapInfo: any = {
                                        type: "FROM_BTCLN",
                                        fromAmount: toDecimal(swap.getTotalInputAmount(), 8),
                                        fromToken: "BTC-LN",
                                        toAmount: toDecimal(swap.getOutputAmount(), tokenData.decimals),
                                        toToken: tokenData.ticker,
                                        identifierHash: _swap.getIdentifierHash(),
                                        escrowHash: _swap.getEscrowHash(),
                                        claimHash: _swap.getClaimHash(),
                                        state: FromBtcLnSwapState[swap.state],
                                        swapFee: toDecimal(swap.swapFee, 8),
                                        invoice: swap.pr
                                    };
                                    swaps.push(swapInfo);
                                }
                            }
                        }
                        return {
                            success: true,
                            swaps: swaps,
                            count: swaps.length
                        };
                    }
                }
            )
        ];

        if(this.bitcoinWallet!=null) {
            this.bitcoinWallet.getCommands().forEach(cmd => commands.push(cmd));
        }

        if(this.lightningWallet!=null) {
            this.lightningWallet.getCommands().forEach(cmd => commands.push(cmd));
            commands.push(
                createCommand(
                    "transferlightning",
                    "Transfer lightning wallet balance, pay lightning network invoice",
                    {
                        args: {
                            invoice: {
                                base: true,
                                description: "Lightning network invoice to pay (must specify an amount!)",
                                parser: cmdStringParser()
                            }
                        },
                        parser: async (args, sendLine) => {
                            if(!this.lightningWallet.isReady()) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                            const parsedInvoice = await this.lightningWallet.parsePaymentRequest(args.invoice);
                            sendLine("Sending lightning tx "+parsedInvoice.id+"...");
                            await this.lightningWallet.pay({
                                request: args.invoice,
                            });
                            sendLine("Waiting for confirmation...");
                            const resp = await this.lightningWallet.waitForPayment(parsedInvoice.id);
                            if(resp.status==="confirmed") {
                                return {
                                    success: true,
                                    status: "confirmed",
                                    message: "Lightning transaction confirmed",
                                    preimage: resp.secret
                                };
                            }
                            if(resp.status==="failed") {
                                return {
                                    success: false,
                                    status: "failed",
                                    message: "Lightning failed! No bitcoin was sent"
                                };
                            }
                            return {
                                success: true,
                                status: "pending",
                                message: "Lightning transaction is taking longer than expected, will be handled in the background"
                            };
                        }
                    }
                )
            );
            commands.push(
                createCommand(
                    "receivelightning",
                    "Creates a lightning network invoice",
                    {
                        args: {
                            amount: {
                                base: true,
                                description: "Amount of BTC to receive over lightning",
                                parser: cmdNumberParser(true, 0, null, true)
                            }
                        },
                        parser: async (args, sendLine) => {
                            if(!this.lightningWallet.isReady()) throw new Error("LND node not ready yet! Monitor the status with the 'status' command");
                            const amtBN = args.amount==null ? null : fromDecimal(args.amount.toFixed(8), 8);
                            const resp = await this.lightningWallet.createInvoice({
                                mtokens: amtBN==null ? undefined : amtBN * 1000n
                            });
                            return {
                                success: true,
                                message: "Lightning network invoice created",
                                invoice: resp.request
                            };
                        }
                    }
                )
            );
        }

        if(this.spvVaultSigner!=null) {
            commands.push(
                createCommand(
                    "listvaults",
                    "Lists created spv vaults",
                    {
                        args: {
                            chainId: {
                                base: true,
                                description: "Chain ID to check spv vaults of",
                                parser: cmdEnumParser<string>(allowedChains, true)
                            },
                            asset: {
                                base: true,
                                description: "Asset to check spv vaults of",
                                parser: cmdStringParser(undefined, undefined, true)
                            }
                        },
                        parser: async (args, sendLine) => {
                            if(args.asset!=null && args.chainId==null) throw new Error("Chain ID needs to be specified when requesting specific asset");

                            const vaults = await this.spvSwapHandler.Vaults.listVaults(
                                args.chainId,
                                args.asset==null ? null : this.tokens[args.asset].chains[args.chainId].address
                            );

                            const assortedVaults: {
                                [chainId: string]: {
                                    [ticker: string]: SpvVault[]
                                }
                            } = {};

                            vaults.forEach(vault => {
                                assortedVaults[vault.chainId] ??= {};
                                const tokenData = this.addressesToTokens[vault.chainId][vault.data.getTokenData()[0].token];
                                assortedVaults[vault.chainId][tokenData.ticker] ??= [];
                                assortedVaults[vault.chainId][tokenData.ticker].push(vault);
                            });

                            for(let chainId in assortedVaults) {
                                for(let ticker in assortedVaults[chainId]) {
                                    sortVaults(assortedVaults[chainId][ticker]);
                                }
                            }

                            const vaultsByChain: any = {};
                            for (let chainId in assortedVaults) {
                                vaultsByChain[chainId] = {};
                                for (let ticker in assortedVaults[chainId]) {
                                    const vaults = assortedVaults[chainId][ticker];
                                    vaults.sort(
                                        (a, b) => bigIntSorter(a.data.getVaultId(), b.data.getVaultId())
                                    );
                                    const tokenData = this.tokens[ticker].chains[chainId];
                                    vaultsByChain[chainId][ticker] = vaults.map((vault, index) => {
                                        const gasTokenData = this.addressesToTokens[chainId][vault.balances[1].token];
                                        const pendingWithdrawals = vault.pendingWithdrawals.map(withdrawal => {
                                            const amounts = vault.fromRawAmounts(withdrawal.getTotalOutput());
                                            return {
                                                txId: withdrawal.getTxId(),
                                                amount: toDecimal(amounts[0], tokenData.decimals),
                                                gasAmount: toDecimal(amounts[1], gasTokenData.decimals),
                                                ticker: ticker,
                                                gasTicker: gasTokenData.ticker
                                            };
                                        });
                                        return {
                                            index: index,
                                            state: SpvVaultState[vault.state],
                                            vaultId: vault.data.getVaultId().toString(),
                                            balance: toDecimal(vault.balances[0].scaledAmount, tokenData.decimals),
                                            ticker: ticker,
                                            gasBalance: toDecimal(vault.balances[1].scaledAmount, gasTokenData.decimals),
                                            gasTicker: gasTokenData.ticker,
                                            requiredConfirmations: vault.data.getConfirmations(),
                                            withdrawalCount: vault.data.getWithdrawalCount(),
                                            latestScUtxo: vault.data.getUtxo(),
                                            latestUtxo: vault.getLatestUtxo(),
                                            pendingWithdrawals: pendingWithdrawals
                                        };
                                    });
                                }
                            }

                            return {
                                success: true,
                                vaults: vaultsByChain
                            };
                        }
                    }
                )
            );
            commands.push(
                createCommand(
                    "createvaults",
                    "Creates new spv vaults",
                    {
                        args: {
                            asset: {
                                base: true,
                                description: "Asset to create a vault for: "+tokenTickers.join(", "),
                                parser: cmdEnumParser<string>(tokenTickers)
                            },
                            count: {
                                base: true,
                                description: "How many vaults to create",
                                parser: cmdNumberParser(false, 1, 100, true)
                            },
                            feeRate: {
                                base: false,
                                description: "Fee rate: sats/vB for BTC transaction",
                                parser: cmdNumberParser(false, 1, null, true)
                            }
                        },
                        parser: async (args, sendLine) => {
                            const {chainId, ticker} = this.fromReadableToken(args.asset);

                            const count = args.count ?? 1;

                            const tokenData = this.tokens[ticker].chains[chainId];
                            const result= await this.spvSwapHandler.Vaults.createVaults(chainId, count, tokenData.address, undefined, args.feeRate);

                            return {
                                success: true,
                                message: "Created " + count + " new vaults, vaults will be opened as soon as the bitcoin transaction gets enough confirmations",
                                vaultCount: count,
                                bitcoinTxId: result.btcTxId
                            };
                        }
                    }
                )
            );
            commands.push(
                createCommand(
                    "depositvault",
                    "Deposits funds to the specific spv vault",
                    {
                        args: {
                            asset: {
                                base: true,
                                description: "Asset to fund the vault with: "+tokenTickers.join(", "),
                                parser: cmdEnumParser<string>(tokenTickers)
                            },
                            vaultId: {
                                base: true,
                                description: "Vault ID to fund",
                                parser: cmdNumberParser(false, 0, undefined, false)
                            },
                            amount: {
                                base: true,
                                description: "Amount of the token to deposit",
                                parser: cmdStringParser(1)
                            },
                            gasAmount: {
                                base: true,
                                description: "Amount of the gas token to deposit",
                                parser: cmdStringParser(1, undefined, true)
                            }
                        },
                        parser: async (args, sendLine) => {
                            const {chainId, ticker} = this.fromReadableToken(args.asset);
                            const tokenData = this.tokens[ticker].chains[chainId];
                            const amountToken0 = fromDecimal(args.amount, tokenData.decimals);

                            const vaults = await this.spvSwapHandler.Vaults.listVaults(chainId, tokenData.address);
                            sortVaults(vaults);

                            const vault: SpvVault = vaults[args.vaultId];
                            if(vault==null) throw new Error("Vault with id "+args.vaultId+" not found!");
                            if(!vault.data.isOpened()) throw new Error("Vault is not opened yet!");

                            const gasTokenData = this.addressesToTokens[chainId][vault.balances[1].token];
                            let amountToken1: bigint = 0n;
                            if(args.gasAmount!=null) {
                                amountToken1 = fromDecimal(args.gasAmount, gasTokenData.decimals);
                            }

                            const rawAmounts = vault.toRawAmounts([amountToken0, amountToken1]);
                            const adjustedAmounts = vault.fromRawAmounts(rawAmounts);
                            sendLine("Amounts scaled and adjusted, depositing: "+
                                toDecimal(adjustedAmounts[0], tokenData.decimals)+" "+ticker+" & "+
                                toDecimal(adjustedAmounts[1], gasTokenData.decimals)+" "+gasTokenData.ticker);

                            const result = await this.spvSwapHandler.Vaults.fundVault(vault, rawAmounts);

                            return {
                                success: true,
                                message: "Funds deposited",
                                transactionId: result
                            };
                        }
                    }
                )
            );

            commands.push(
                createCommand(
                    "withdrawvault",
                    "Withdraw funds from the specific spv vault",
                    {
                        args: {
                            asset: {
                                base: true,
                                description: "Asset to fund the vault with: "+tokenTickers.join(", "),
                                parser: cmdEnumParser<string>(tokenTickers)
                            },
                            vaultId: {
                                base: true,
                                description: "Vault ID to fund",
                                parser: cmdNumberParser(false, 0, undefined, false)
                            },
                            amount: {
                                base: true,
                                description: "Amount of the token to withdraw",
                                parser: cmdStringParser(1)
                            },
                            gasAmount: {
                                base: true,
                                description: "Amount of the gas token to withdraw",
                                parser: cmdStringParser(1, undefined, true)
                            },
                            feeRate: {
                                base: false,
                                description: "Fee rate: sats/vB for BTC transaction",
                                parser: cmdNumberParser(false, 1, null, true)
                            }
                        },
                        parser: async (args, sendLine) => {
                            const {chainId, ticker} = this.fromReadableToken(args.asset);
                            const tokenData = this.tokens[ticker].chains[chainId];
                            const amountToken0 = fromDecimal(args.amount, tokenData.decimals);

                            const vaults = await this.spvSwapHandler.Vaults.listVaults(chainId, tokenData.address);
                            sortVaults(vaults);

                            const vault: SpvVault = vaults[args.vaultId];
                            if(vault==null) throw new Error("Vault with id "+args.vaultId+" not found!");
                            if(!vault.data.isOpened()) throw new Error("Vault is not opened yet!");

                            const gasTokenData = this.addressesToTokens[chainId][vault.balances[1].token];
                            let amountToken1: bigint = 0n;
                            if(args.gasAmount!=null) {
                                amountToken1 = fromDecimal(args.gasAmount, gasTokenData.decimals);
                            }

                            const rawAmounts = vault.toRawAmounts([amountToken0, amountToken1]);
                            const adjustedAmounts = vault.fromRawAmounts(rawAmounts);
                            sendLine("Amounts scaled and adjusted, withdrawing: "+
                                toDecimal(adjustedAmounts[0], tokenData.decimals)+" "+ticker+" & "+
                                toDecimal(adjustedAmounts[1], gasTokenData.decimals)+" "+gasTokenData.ticker);

                            const result = await this.spvSwapHandler.Vaults.withdrawFromVault(vault, rawAmounts, args.feeRate);

                            return {
                                success: true,
                                message: "Funds withdrawal initiated, funds will be automatically claimed when bitcoin transaction gets " + vault.data.getConfirmations() + " confirmations",
                                bitcoinTransactionId: result,
                                requiredConfirmations: vault.data.getConfirmations()
                            };
                        }
                    }
                )
            );
        }

        // Create TCP CLI config
        const tcpCliConfig: TcpCliConfig = {
            address: IntermediaryConfig.CLI.ADDRESS,
            port: IntermediaryConfig.CLI.PORT,
            introMessage: "Welcome to atomiq intermediary (LP node) CLI!"
        };

        // Create RPC config if RPC is configured
        const rpcConfig: RpcConfig | undefined = IntermediaryConfig.RPC ? {
            address: IntermediaryConfig.RPC.ADDRESS,
            port: IntermediaryConfig.RPC.PORT
        } : undefined;

        this.cmdHandler = new CommandHandler(commands, tcpCliConfig, rpcConfig);
    }

    async init() {
        await this.cmdHandler.init();
        await super.init();
        for(let plugin of PluginManager.plugins.values()) {
            if(plugin.getCommands!=null) {
                plugin.getCommands().forEach(cmd => this.cmdHandler.registerCommand(cmd));
            }
        }
    }

}