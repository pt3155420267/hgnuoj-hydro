import { pick } from 'lodash';
import LRU from 'lru-cache';
import { Student, User } from '../interface';
// import { UserNotFoundError } from '../error';
import { Logger } from '../logger';
import * as bus from '../service/bus';
import db from '../service/db';
import { Value } from '../typeutils';
// import { PERM, PRIV } from './builtin';
import { ArgMethod } from '../utils';
import UserModel from './user';

const coll = db.collection('stu.info');
const domainUsercoll = db.collection('domain.user');

const logger = new Logger('model/stuinfo');
const cache = new LRU<string, any>({ max: 500, maxAge: 300 * 1000 });

export function deleteStudentCache(studoc: Student | string | undefined | null, receiver = false) {
    if (!studoc) return;
    if (!receiver) {
        bus.broadcast(
            'student/delcache',
            JSON.stringify(typeof studoc === 'string' ? studoc : pick(studoc, ['stuid', '_id'])),
        );
    }
    if (typeof studoc === 'string') {
        for (const key of cache.keys().filter((k) => k.endsWith(`/${studoc}`))) cache.del(key);
        return;
    }
    const id = [`uid/${studoc._id.toString()}`, `stuid/${studoc.stuid.toLowerCase()}`];
    for (const key of cache.keys().filter((k) => id.includes(`${k.split('/')[0]}/${k.split('/')[1]}`))) {
        cache.del(key);
    }
}
bus.on('student/delcache', (content) => deleteStudentCache(JSON.parse(content), true));

class StudentModel {
    @ArgMethod
    static async getStuInfoById(_id: number): Promise<Student | null> {
        if (cache.has(`uid/${_id}`)) return cache.get(`uid/${_id}`);
        const studoc = await coll.findOne({ _id });
        if (!studoc) return null;
        cache.set(`uid/${studoc._id}`, studoc);
        return studoc;
    }

    @ArgMethod
    static async getStuInfoByStuId(stuid: string): Promise<Student | null> {
        if (cache.has(`stuid/${stuid}`)) return cache.get(`stuid/${stuid}`);
        const studoc = await coll.findOne({ stuid });
        if (!studoc) return null;
        cache.set(`stuid/${stuid}`, studoc);
        return studoc;
    }

    @ArgMethod
    static async create(uid: number, classname?: string, name?: string, stuid?: string) {
        try {
            await coll.insertOne({
                _id: uid,
                name,
                class: classname,
                stuid,
            });
        } catch (e) {
            logger.warn('%o', e);
        }
    }

    @ArgMethod
    static async setById(uid: number, $set?: Partial<Student>, $unset?: Value<Partial<Student>, ''>) {
        const op: any = {};
        if ($set && Object.keys($set).length) op.$set = $set;
        if ($unset && Object.keys($unset).length) op.$unset = $unset;
        if (Object.getOwnPropertyNames(op).length === 0) return null;
        const res = await coll.findOneAndUpdate({ _id: uid }, op, { returnDocument: 'after' });
        deleteStudentCache(uid.toString());
        return res;
    }

    @ArgMethod
    static setStuID(uid: number, stuid: string) {
        return StudentModel.setById(uid, { stuid });
    }

    @ArgMethod
    static setName(uid: number, name: string) {
        return StudentModel.setById(uid, { name });
    }

    @ArgMethod
    static setClass(uid: number, cls: string) {
        return StudentModel.setById(uid, { class: cls });
    }

    static async getUserUidsByClassName(domain: string, cls: string): Promise<number[]> {
        const uids: number[] = [];
        const cursor = coll.find({ class: cls }, { sort: { stuid: 1 } });
        for (const student of await cursor.toArray()) uids.push(student._id);
        return uids;
    }

    static async getUserListByClassName(domain: string, cls: string): Promise<User[]> {
        const uids: number[] = await this.getUserUidsByClassName(domain, cls);
        const udocs: User[] = await Promise.all(uids.map(async (uid) => await UserModel.getById(domain, uid)));
        return udocs;
    }

    static async getClassList(domain: string = 'system'): Promise<object[]> {
        if (cache.has('classList')) return cache.get('classList');
        const clsCursor = await coll.aggregate([
            { $match: { class: { $not: { $in: [null, ''] } } } },
            { $group: { _id: '$class', stuNum: { $sum: 1 } } },
        ]).map((async (cls) => {
            const users: number[] = await this.getUserUidsByClassName(domain, cls._id.toString());
            const clsInfoList = await domainUsercoll.aggregate([
                { $match: { uid: { $in: users } } },
                {
                    $group: {
                        _id: 'result',
                        nAccept: { $sum: '$nAccept' },
                        nSubmit: { $sum: '$nSubmit' },
                        rpSum: { $sum: '$rp' },
                        rpAvg: { $avg: '$rp' },
                    },
                },
            ]).toArray();
            if (!clsInfoList.length) {
                return {
                    ...cls, nAccept: 0, nSubmit: 0, rpSum: 0, rpAvg: 0,
                };
            }
            return { ...clsInfoList[0], ...cls };
        })).toArray();

        const clsList: any[] = await Promise.all(clsCursor);
        clsList.sort((a, b) => b.nAccept - a.nAccept || b.stuNum - a.stuNum || b.nSubmit - a.nSubmit || b._id - a._id);
        bus.broadcast('student/cacheClassList', JSON.stringify(clsList));
        return clsList;
    }
}

bus.on('student/cacheClassList', (content: string) => cache.set('classList', JSON.parse(content)));

bus.once('app/started', () => db.ensureIndexes(
    coll,
    {
        key: { stuid: 1 }, name: 'stuid', unique: true, sparse: true,
    },
    { key: { name: 1 }, name: 'name', sparse: true },
    { key: { class: 1, name: 1 }, name: '(class,name)', sparse: true },
));
global.Hydro.model.student = StudentModel;
export default StudentModel;
