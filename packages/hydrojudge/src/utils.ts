import { EventEmitter } from 'events';
import path from 'path';
import fs from 'fs-extra';
import _ from 'lodash';
import { parse } from 'shell-quote';
import { sleep } from '@hydrooj/utils/lib/utils';
import { FormatError } from './error';

const EMPTY_STR = /^[ \r\n\t]*$/i;

export const cmd = parse;

export function parseFilename(filePath: string) {
    const t = filePath.split('/');
    return t[t.length - 1];
}

export class Queue<T> extends EventEmitter {
    queue: T[] = [];
    waiting: any[] = [];

    get(count = 1) {
        if (this.queue.length < count) {
            return new Promise<T[]>((resolve) => {
                this.waiting.push({ count, resolve });
            });
        }
        const items = [];
        for (let i = 0; i < count; i++) items.push(this.queue[i]);
        this.queue = _.drop(this.queue, count);
        return items as T[];
    }

    push(value: T) {
        this.queue.push(value);
        if (this.waiting.length && this.waiting[0].count <= this.queue.length) {
            const items = [];
            for (let i = 0; i < this.waiting[0].count; i++) items.push(this.queue[i]);
            this.queue = _.drop(this.queue, this.waiting[0].count);
            this.waiting[0].resolve(items);
            this.waiting.shift();
        }
    }
}

export namespace Lock {
    const data = {};

    export async function acquire(key: string) {
        // eslint-disable-next-line no-await-in-loop
        while (data[key]) await sleep(100);
        data[key] = true;
    }

    export function release(key: string) {
        data[key] = false;
    }
}

export function compilerText(stdout: string, stderr: string) {
    const ret = [];
    if (!EMPTY_STR.test(stdout)) ret.push(stdout.substring(0, 1024 * 1024));
    if (!EMPTY_STR.test(stderr)) ret.push(stderr.substring(0, 1024 * 1024));
    return ret.join('\n');
}

export function restrictFile(p: string) {
    if (!p) return '/';
    if (p[0] === '/') p = '';
    return p.replace(/\.\./gmi, '');
}

export function ensureFile(folder: string) {
    return (file: string, message: string) => {
        if (file === '/dev/null') return file;
        // Historical issue
        if (file.includes('/')) {
            const f = path.join(folder, restrictFile(file.split('/')[1]));
            if (fs.existsSync(f)) {
                const stat = fs.statSync(f);
                if (stat.isFile()) return f;
            }
        }
        const f = path.join(folder, restrictFile(file));
        if (!fs.existsSync(f)) throw new FormatError(message, [file]);
        const stat = fs.statSync(f);
        if (!stat.isFile()) throw new FormatError(message, [file]);
        return f;
    };
}

export * from '@hydrooj/utils/lib/utils';
