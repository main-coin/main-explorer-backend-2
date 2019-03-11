import { Module, Controller, Injectable, Inject, Logger } from '@nestjs/common';
import { BaseNetworkService } from 'blockchain/base-network.service';
import {
  MessagePattern,
  ClientProxy,
  Client,
  Transport,
} from '@nestjs/microservices';
import {
  BlockDto,
  StateUpdateDto,
  TransactionDto,
  TransferDto,
  ApproveDto,
  EventDto,
  EventType,
  HolderUpdateDto,
} from 'common/dto';
import { DeepPartial } from 'common/types';
import * as Bluebird from 'bluebird';
import { ethers } from 'ethers';
import { Transaction, sha256, BigNumber } from 'ethers/utils';
import { Log, TransactionResponse, TransactionRequest } from 'ethers/providers';
import { ServiceModule } from 'service.module';
import { ClientProvider } from 'common/client.provider';

export interface UpdateRequestOptions {
  blockHeight: number;
  tokenAddress: string;
  blockHash: string;
}

@Injectable()
export class BlockService extends BaseNetworkService {
  createHolderUpdate(address: string) {
    const tmp = new HolderUpdateDto();
    tmp.address = address;
    tmp.incoming = '0';
    tmp.outgoing = '0';
    return tmp;
  }
  parseEvents(logs: Log[], options: Partial<UpdateRequestOptions>) {
    if (!options.tokenAddress) {
      return [];
    }

    return logs
      .map((log, index) => ({ log, index }))
      .filter(log => log.log.address === options.tokenAddress)
      .map(log => Object.assign(log, { parsed: this.erc20.parseLog(log.log) }))
      .filter(log => ['Transfer', 'Approve'].includes(log.parsed.name))
      .map(log => {
        switch (log.parsed.name) {
          case 'Transfer':
            const transfer = new TransferDto();
            transfer.from = log.parsed.values.from;
            transfer.to = log.parsed.values.to;
            transfer.value = log.parsed.values.value;
            transfer.eventIndex =
              log.log.logIndex || log.log.transactionLogIndex || log.index;
            return transfer;
          case 'Approve':
            const approve = new ApproveDto();
            approve.owner = log.parsed.values.owner;
            approve.spender = log.parsed.values.spender;
            approve.value = log.parsed.values.value;
            return approve;
          default:
            throw new Error('something wrong with parsing');
        }
      });
  }

  async getTransaction(hash: string, options: Partial<UpdateRequestOptions>) {
    const native = Object.assign(
      await this.provider().getTransaction(hash),
      await this.provider().getTransactionReceipt(hash),
    );

    const tx = new TransactionDto();
    tx.sender = native.from;
    tx.nonce = native.nonce;
    tx.hash = native.transactionHash;
    tx.gasPrice = native.gasPrice.toString();
    tx.gasLimit = native.gasLimit.toString();
    tx.gasConsumed = native.gasUsed.toString();
    tx.r = native.r;
    tx.s = native.s;
    tx.v = native.v;
    tx.receiver = native.to;
    tx.events = this.parseEvents(native.logs, options);
    tx.index = native.transactionIndex;
    return tx;
  }
  async getIncomingBlocks(
    since: number,
    options: Partial<UpdateRequestOptions>,
  ) {
    const heightInNetwork = await this.provider().getBlockNumber();

    if (typeof heightInNetwork !== 'number') {
      throw new Error("Can't receive height of network " + heightInNetwork);
    }
    // new blocks
    let lookup = Math.min(
      process.env.BLOCK_MAX_LOOKUP_DISTANCE,
      heightInNetwork - since,
    );

    return await Bluebird.all(
      Array(lookup)
        .fill(0)
        .map((_, index) =>
          this.provider()
            .getBlock(since + index + 1, true)
            .then(block => {
              const a = new BlockDto();
              a.parentHash = block.parentHash;
              a.blockHash = block.hash;
              a.blockHeight = block.number;
              a.time = new Date(block.timestamp * 1000);
              a.transactionHashes = (block.transactions as any[]).map(
                (tx: Transaction | string) => {
                  if (typeof tx === 'object' && tx.hash) {
                    return tx.hash;
                  } else if (typeof tx === 'string') {
                    return tx;
                  } else {
                    throw new Error('unknown tx');
                  }
                },
              );
              return a;
            }),
        ),
    ).timeout(process.env.BLOCK_REQUEST_TIMEOUT, 'getBlock timeout');
  }

  async getStateUpdate(
    options: Partial<UpdateRequestOptions>,
  ): Promise<DeepPartial<StateUpdateDto>> {
    if (typeof options.blockHeight !== 'number') {
      throw new Error('Latest blockheight is important');
    }
    const update = new StateUpdateDto();

    if (options.blockHash) {
      // check if hash of latest known block is same
      const possibleSameLatest = await this.provider().getBlock(
        options.blockHeight,
      );

      if (!possibleSameLatest || possibleSameLatest.hash != options.blockHash) {
        // chain reorganization
        update.reversedBlocks.push(options.blockHash!);
        return update;
      }
    }

    update.incomingBlocks = await this.getIncomingBlocks(
      options.blockHeight,
      options,
    );

    for (let block of update.incomingBlocks) {
      const transactions = await Bluebird.map(
        block.transactionHashes,
        hash => this.getTransaction(hash, options),
        { concurrency: process.env.BLOCK_REQUEST_TX_BATCH },
      );

      block.transactions = transactions;

      const transfers = block.transactions
        .map(tx => tx.events)
        .reduce((flat, events) => flat.concat(events), [])
        .filter(ev => ev.eventType == EventType.Transfer)
        .map(ev => ev as TransferDto);
      const holders = transfers.reduce(
        (holders, influence) => {
          const from = (holders[influence.from] =
            holders[influence.from] || this.createHolderUpdate(influence.from));

          const to = (holders[influence.to] =
            holders[influence.to] || this.createHolderUpdate(influence.to));

          from.outgoing = new BigNumber(from.outgoing)
            .add(influence.value)
            .toString();

          to.incoming = new BigNumber(to.incoming)
            .add(influence.value)
            .toString();

          return holders;
        },
        {} as { [address: string]: HolderUpdateDto },
      );

      block.holdersUpdate = Object.values(holders);
    }

    return update;
  }
}

@Controller('block')
export class BlockController {
  constructor(private readonly service: BlockService) {}

  @MessagePattern({ service: 'block', cmd: 'get_state_update' })
  getStateUpdate(
    payload: Partial<UpdateRequestOptions>,
  ): Promise<DeepPartial<StateUpdateDto>> {
    console.log('get_state_update call')
    return this.service.getStateUpdate(
      Object.assign(
        {
          blockHeight: 0,
        },
        payload,
      ),
    );
  }
}

@Injectable()
export class BlockchainDemon {
  constructor(private readonly client: ClientProxy) {
    this.loop();
  }

  async loop() {
    await new Promise(resolve => setTimeout(resolve, 1500))
    console.log('test getting update')
    console.log(await this.client.send<any, Partial<UpdateRequestOptions>>(
      { service: 'block', cmd: 'get_state_update' },
      {
        blockHeight: process.env.BLOCK_FROM_BLOCK,
        tokenAddress: process.env.BLOCK_TOKEN_ADDRESS,
      },
    ).toPromise());
  }

  async onModuleInit() {
    console.log('connecting to mesh...');
    await this.client.connect();
    console.log('Done!');
  }
}

@Module({
  providers: [
    {
      provide: Logger,
      useValue: new Logger('test logger'),
    },
    ClientProvider,
    {
      provide: 'provider',
      useFactory: () => () =>
        new ethers.providers.JsonRpcProvider({
          url: process.env.WEB3_URL,
          allowInsecure: true,
        }),
    },
    BlockService,
    BlockchainDemon,
  ],
  controllers: [BlockController],
})
export class BlockModule {}
