import { AccountAddress, NftItem } from "tonapi-sdk-js";
import { CoinRepository } from "../db/coin.service";
import { ICoinDTO } from "../db/schemas/coin.schema";
import { ICoinsHold, INFTCollection, IWalletDTO } from "../db/schemas/wallet.schema";
import { WalletRepository } from "../db/wallet.service";
import { fromNano, getNftItems, getTokenHolders, hexToStringAddr, stringToHexAddr } from "../ton-core/tonWallet";
import { CollectionRepository } from "../db/collection.service";
import { ICollectionDTO } from "../db/schemas/collection.schema";
import { IUserDTO } from "../db/schemas/user.schema";
import { UserRepository } from "../db/user.service";
import { getTier } from "../states";
import { UserStorage } from "../ton-connect/storage";

let walletsLocal = new Map<string, IWalletDTO>();

const userLocal = new UserStorage()

export class Screan{
    constructor(
        private coinRepository: CoinRepository,
        private collectionRepository: CollectionRepository,
        private walletRepository: WalletRepository,
        private userRepository: UserRepository
    ){
        this.screan = this.screan.bind(this);
        this.processCoins = this.processCoins.bind(this);
        this.screenCoin = this.screenCoin.bind(this);
        this.processCollections = this.processCollections.bind(this);
        this.screenCollection = this.screenCollection.bind(this);
        this.processWallets = this.processWallets.bind(this);
        this.processUsers = this.processUsers.bind(this);
    }

    async screan(){ 
        const coins = await this.coinRepository.findActiveCoins();
        const collections = await this.collectionRepository.findActiveCollections();
        const users = await this.userRepository.findAllUsers();

        await this.processCoins(coins);
        await this.processCollections(collections);
        await this.processWallets(walletsLocal);
        await this.walletRepository.updateMany(Array.from(walletsLocal.values()));
        await this.processUsers(users);

        walletsLocal = new Map<string, IWalletDTO>();
    }

    private async processCoins(coins: ICoinDTO[]): Promise<void>{
        for (const coin of coins) {
            const holders = await getTokenHolders(coin.address);
            await Promise.all(holders.addresses.map(async (holder) => {
                await this.screenCoin(coin, holder);
            }));
        }
    }

    private async screenCoin(coin: ICoinDTO, holder: {address: string, owner: AccountAddress, balance: string}): Promise<void>{
        const balance = fromNano(BigInt(holder.balance));
        let wallet = walletsLocal.get(holder.owner.address);

        const updateData: ICoinsHold = {
            coinAddress: coin.address,
            balance: await balance,
            points: (await balance * coin.pointsPerCoin)
        }

        if (!wallet){
            wallet = {address: hexToStringAddr(holder.owner.address)};
        }

        if (!wallet.coinsHold) wallet.coinsHold = [];
        wallet.coinsHold?.push(updateData);
        walletsLocal.set(holder.owner.address, wallet);
    }

    private async processCollections(collections: ICollectionDTO[]){
        for (const collection of collections) {
            const items = await getNftItems(collection.address);
            const groupedItems: {[key: string]: NftItem[]} = {};

            for (const item of items.nft_items){
                const addressKey = item.sale ? item.sale.owner?.address! : item.owner?.address!;
                if (!groupedItems[addressKey]){
                    groupedItems[addressKey] = [];
                }
                groupedItems[addressKey].push(item);
            }

            for (const addressKey in groupedItems){
                if (groupedItems.hasOwnProperty(addressKey)){
                    const items = groupedItems[addressKey];
                    await this.screenCollection(collection, addressKey, items);
                }
            }
        }
    }

    private async screenCollection(collection: ICollectionDTO, ownerAddress: string, groupedItems: NftItem[]){
        let wallet = walletsLocal.get(ownerAddress);

        const updateData: INFTCollection = {
            collectionAddress: collection.address,
            NFTAddress: groupedItems.map(item =>item.address),
            points: groupedItems.length * collection.pointsPerItem
        }

        if (!wallet){
            wallet = {address: hexToStringAddr(ownerAddress)};
        }

        if (!wallet.NFTCollections) wallet.NFTCollections = [];
        wallet.NFTCollections?.push(updateData);
        walletsLocal.set(ownerAddress, wallet);
    }

    private async processWallets(wallets: Map<string, IWalletDTO>){
        wallets.forEach(wallet =>{
            if (wallet.NFTCollections){
                wallet.NFTPointsTotal = wallet.NFTCollections.reduce((total, collection) => total + collection.points, 0);
            }
            if (wallet.coinsHold){
                wallet.coinsPointsTotal = wallet.coinsHold.reduce((total, hold) => total + hold.points, 0);
            }
            wallet.walletPointsTotal = (wallet.coinsPointsTotal ?? 0) + (wallet.NFTPointsTotal ?? 0);
            walletsLocal.set(wallet.address, wallet);
        })
    }

    private async processUsers(users: IUserDTO[]){
        users.forEach(user =>{
            let points: number = 0;
            user.wallets?.forEach(wall =>{
                const wallet = walletsLocal.get(stringToHexAddr(wall));
                if (wallet){
                    points += wallet.walletPointsTotal ?? 0;
                }
            })
            user.pointsTotal = points;
            user.tier = getTier(points);
            userLocal.remove(user.chatId);
        })

        await this.userRepository.updateMany(users);
    }
}