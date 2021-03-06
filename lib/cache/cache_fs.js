'use strict';
const { CacheBase, PutTransaction } = require('./cache_base');
const helpers = require('../helpers');
const path = require('path');
const fs = require('fs-extra');
const uuid = require('uuid');
const consts = require('../constants');
const klaw = require('klaw');
const moment = require('moment');
const { Transform } = require('stream');

class CacheFS extends CacheBase {
    constructor() {
        super();
    }

    static get properties() {
        return {
            clustering: true,
            cleanup: true
        }
    }

    /**
     *
     * @param {String} type
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @returns {string}
     * @private
     */
    static _calcFilename(type, guid, hash) {
        const ext = { 'i': 'info', 'a': 'bin', 'r': 'resource' }[type];
        return `${helpers.GUIDBufferToString(guid)}-${hash.toString('hex')}.${ext}`;
    }

    /**
     *
     * @param {String} type
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @returns {String}
     * @private
     */
    _calcFilepath(type, guid, hash) {
        let fileName = CacheFS._calcFilename(type, guid, hash);
        return path.join(this._cachePath, fileName.substr(0, 2), fileName);
    }

    get _optionsPath() {
        return super._optionsPath + ".cache_fs";
    }

    init(options) {
        return super.init(options);
    }

    shutdown() {
        return Promise.resolve();
    }

    async _addFileToCache(type, guid, hash, sourcePath) {
        let filePath = this._calcFilepath(type, guid, hash);
        await fs.move(sourcePath, filePath, { overwrite: true });
        return filePath;
    }

    async getFileInfo(type, guid, hash) {
        const stats = await fs.stat(this._calcFilepath(type, guid, hash));
        return {size: stats.size};
    }

    getFileStream(type, guid, hash) {
        let stream = fs.createReadStream(this._calcFilepath(type, guid, hash));

        return new Promise((resolve, reject) => {
            stream.on('open', () => resolve(stream))
                .on('error', err => {
                helpers.log(consts.LOG_ERR, err);
                reject(err);
            });
        });
    }

    async createPutTransaction(guid, hash) {
       return new PutTransactionFS(guid, hash, this._cachePath);
    }

    async endPutTransaction(transaction) {
        let self = this;

        let moveFile = async (file) => {
            self._addFileToCache(file.type, transaction.guid, transaction.hash, file.file)
                .then(filePath => helpers.log(consts.LOG_TEST, `Added file to cache: ${file.size} ${filePath}`),
                        err => helpers.log(consts.LOG_ERR, err));
        };

        await transaction.finalize();
        return Promise.all(transaction.files.map(moveFile));
    }

    registerClusterWorker(worker) {}

    cleanup(dryRun = true) {
        const self = this;

        const expireDuration = moment.duration(this._options.cleanupOptions.expireTimeSpan);
        if(!expireDuration.isValid() || expireDuration.asMilliseconds() === 0) {
            return Promise.reject(new Error("Invalid expireTimeSpan option"));
        }

        const minFileAccessTime = moment().subtract(expireDuration).toDate();
        const maxCacheSize = this._options.cleanupOptions.maxCacheSize;

        let allItems = [];
        let deleteItems = [];
        let cacheSize = 0;
        let deleteSize = 0;

        let progressData = () => {
            return { cacheCount: allItems.length, cacheSize: cacheSize, deleteCount: deleteItems.length, deleteSize: deleteSize };
        };

        let filterTransform = new Transform({
            objectMode: true,
            transform(item, enc, next) {
                if(item.stats.isDirectory()) return next();
                allItems.push(item);
                cacheSize += item.stats.size;
                if(item.stats.atime < minFileAccessTime) {
                    deleteSize += item.stats.size;
                    this.push(item);
                }

                self.emit('cleanup_search_progress', progressData());

                next();
            }
        });

        let finalize = async () => {
            if(maxCacheSize > 0 && cacheSize - deleteSize > maxCacheSize) {
                allItems.sort((a, b) => { return a.stats.atime > b.stats.atime });
                for(let item of allItems) {
                    self.emit('cleanup_search_progress', progressData());
                    deleteSize += item.stats.size;
                    deleteItems.push(item.path);
                    if(cacheSize - deleteSize <= maxCacheSize) break;
                }
            }

            self.emit('cleanup_search_finish', progressData());

            if(!dryRun) {
                for(let item of deleteItems) {
                    self.emit('cleanup_delete_item', item);
                    await fs.unlink(item);
                }
            }

            self.emit('cleanup_delete_finish', progressData());
        };

        return new Promise((resolve, reject) => {
            klaw(self._cachePath)
                .on('error', err => reject(err))
                .pipe(filterTransform)
                .on('data', item => deleteItems.push(item.path))
                .on('end', () => finalize().catch(reject).then(resolve));
        });
    }
}

class PutTransactionFS extends PutTransaction {
    /**
     *
     * @param {Buffer} guid
     * @param {Buffer} hash
     * @param {String} cachePath
     */
    constructor(guid, hash, cachePath) {
        super(guid, hash);
        /**
         * @type {String}
         * @private
         */
        this._cachePath = cachePath;

        this._writeOptions = {
            flags: 'w',
            encoding: 'ascii',
            fd: null,
            mode: 0o666,
            autoClose: true
        };

        this._streams = {};
        this._files = [];
    }

    async _closeAllStreams() {
        let self = this;
        let files = Object.values(this._streams);
        if(files.length === 0) return;

        function processClosedStream(stream) {
            if(stream.stream.bytesWritten === stream.size) {
                self._files.push({
                    file: stream.file,
                    type: stream.type,
                    size: stream.size
                });
            }
            else {
                throw new Error("Transaction failed; file size mismatch");
            }
        }

        for(let file of files) {
            if(file.stream.closed) {
                processClosedStream(file);
                continue;
            }

            await new Promise((resolve, reject) => {
                file.stream.on('close', () => {
                    try {
                        processClosedStream(file);
                        resolve();
                    }
                    catch(err) {
                        reject(err);
                    }
                });
            });
        }
    }

    get manifest() {
        return this.files.map((file) => file.type);
    }

    get files() {
        return this._files;
    }

    async finalize() {
        await this._closeAllStreams();
        return super.finalize();
    }

    async getWriteStream(type, size) {
        let file = path.join(this._cachePath, uuid());

        if(typeof(size) !== 'number' || size <= 0) {
            throw new Error("Invalid size for write stream");
        }

        if(type !== 'a' && type !== 'i' && type !== 'r') {
            throw new Error(`Unrecognized type '${type}' for transaction.`);
        }

        await fs.ensureFile(file);
        const stream = fs.createWriteStream(file, this._writeOptions);
        this._streams[type] = {
            file: file,
            type: type,
            size: size,
            stream: stream
        };

        return new Promise(resolve => stream.on('open', () => resolve(stream)));
    }
}

module.exports = CacheFS;