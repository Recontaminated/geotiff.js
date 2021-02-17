import LRUCache from 'lru-cache';
import { BaseSource } from './basesource';
import { wait } from '../utils';

class Block {
  /**
   *
   * @param {number} offset
   * @param {number} length
   * @param {ArrayBuffer} [data]
   */
  constructor(offset, length, data = null) {
    this.offset = offset;
    this.length = length;
    this.data = data;
  }

  /**
   * @returns {number} the top byte border
   */
  get top() {
    return this.offset + this.length;
  }
}


class BlockGroup {
  /**
   *
   * @param {number} offset
   * @param {number} length
   * @param {number[]} blockIds
   */
  constructor(offset, length, blockIds) {
    this.offset = offset;
    this.length = length;
    this.blockIds = blockIds;
  }
}


export class BlockedSource extends BaseSource {
  /**
   *
   * @param {Source} source The underlying source that shall be blocked and cached
   * @param {object} options
   */
  constructor(source, { blockSize = 65536, cacheSize = 100 } = {}) {
    super();
    this.source = source;
    this.blockSize = blockSize;

    this.blockCache = new LRUCache({ max: cacheSize });

    // mapping blockId -> Block instance
    this.blockRequests = new Map();

    // set of blockIds missing for the current requests
    this.blockIdsToFetch = new Set();
  }

  get fileSize() {
    return this.source.fileSize;
  }

  /**
   *
   * @param {./basesource/Slice[]} slices
   */
  async fetch(slices, signal) {
    const cachedBlocks = new Map();
    const blockRequests = new Map();
    const missingBlockIds = new Set();

    for (const { offset, length } of slices) {
      let top = offset + length;

      const { fileSize } = this;
      if (fileSize !== null) {
        top = Math.min(top, fileSize);
      }

      const firstBlockOffset = Math.floor(offset / this.blockSize) * this.blockSize;

      // chunk the current slice into blocks
      for (let current = firstBlockOffset; current < top; current += this.blockSize) {
        // check if the block is cached, being requested or still missing
        const blockId = Math.floor(current / this.blockSize);

        if (this.blockCache.has(blockId)) {
          cachedBlocks.set(blockId, this.blockCache.get(blockId));
        } else if (this.blockRequests.has(blockId)) {
          blockRequests.set(blockId, this.blockRequests.get(blockId));
        } else {
          this.blockIdsToFetch.add(blockId);
          missingBlockIds.add(blockId);
        }
      }
    }

    // allow additional block requests to accumulate
    await wait();

    // check if we still need to
    if (this.blockIdsToFetch.size > 0) {
      const groups = this.groupBlocks(this.blockIdsToFetch);

      // start requesting slices of data
      const groupRequests = this.source.fetch(groups, signal);

      for (let groupIndex = 0; groupIndex < groups.length; ++groupIndex) {
        const group = groups[groupIndex];

        for (const blockId of group.blockIds) {
          // make an async IIFE for each block
          const blockRequest = (async () => {
            const response =  (await groupRequests)[groupIndex];
            const blockOffset = blockId * this.blockSize;
            const o = blockOffset - response.offset;
            const t = Math.min(o + this.blockSize, response.data.byteLength);
            const data = response.data.slice(o, t);
            const block = new Block(
              blockOffset,
              data.byteLength,
              data,
            );
            this.blockRequests.delete(blockId);
            this.blockCache.set(blockId, block);
            return block;
          })();
          this.blockRequests.set(blockId, blockRequest);
        }
      }
      this.blockIdsToFetch.clear();
    }

    for (const blockId of missingBlockIds) {
      const block = this.blockRequests.get(blockId);
      if (!block) {
        throw new Error(`Block ${blockId} is not in the block requests`);
      }
      blockRequests.set(blockId, block);
    }

    // TODO: extract
    const zip = (a, b) => a.map((k, i) => [k, b[i]]);

    // actually await all pending requests
    const values = await Promise.all(Array.from(blockRequests.values()));

    // create a final Map, with all required blocks for this request to satisfy
    const requiredBlocks = new Map(zip(Array.from(blockRequests.keys()), values));
    for (const [blockId, block] of cachedBlocks) {
      requiredBlocks.set(blockId, block);
    }

    // TODO: satisfy each slice
    return this.readSliceData(slices, requiredBlocks);
  }

  /**
   *
   * @param {Set} blockIds
   * @returns {BlockGroup[]}
   */
  groupBlocks(blockIds) {
    const sortedBlockIds = Array.from(blockIds).sort((a, b) => a - b);
    if (sortedBlockIds.length === 0) {
      return [];
    }
    let current = [];
    let lastBlockId = null;
    const groups = [];

    for (const blockId of blockIds) {
      if (lastBlockId === null || lastBlockId + 1 === blockId) {
        current.push(blockId);
        lastBlockId = blockId;
      } else {
        groups.push(new BlockGroup(
          current[0] * this.blockSize,
          current.length * this.blockSize,
          current,
        ));
        current = [blockId];
        lastBlockId = null;
      }
    }

    groups.push(new BlockGroup(
      current[0] * this.blockSize,
      current.length * this.blockSize,
      current,
    ));

    return groups;
  }

  /**
   *
   * @param {Slice[]} slices
   * @param {Map} blocks
   */
  readSliceData(slices, blocks) {
    return slices.map((slice) => {
      const top = slice.offset + slice.length;
      const blockIdLow = Math.floor(slice.offset / this.blockSize);
      const blockIdHigh = Math.floor((slice.offset + slice.length) / this.blockSize);
      const sliceData = new ArrayBuffer(slice.length);
      const sliceView = new Uint8Array(sliceData);

      for (let blockId = blockIdLow; blockId <= blockIdHigh; ++blockId) {
        const block = blocks.get(blockId);
        const delta = block.offset - slice.offset;
        const topDelta = block.top - top;
        let blockInnerOffset = 0;
        let rangeInnerOffset = 0;
        let usedBlockLength;

        if (delta < 0) {
          blockInnerOffset = -delta;
        } else if (delta > 0) {
          rangeInnerOffset = delta;
        }

        if (topDelta < 0) {
          usedBlockLength = block.length - blockInnerOffset;
        } else {
          usedBlockLength = top - block.offset - blockInnerOffset;
        }

        const blockView = new Uint8Array(block.data, blockInnerOffset, usedBlockLength);
        sliceView.set(blockView, rangeInnerOffset);
      }

      return sliceData;
    });
  }
}
