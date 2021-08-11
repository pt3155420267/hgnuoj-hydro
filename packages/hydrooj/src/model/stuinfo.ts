import LRU from 'lru-cache';
import { pick } from 'lodash';
// import { PERM, PRIV } from './builtin';
import { ArgMethod } from '../utils';
// import { UserNotFoundError } from '../error';
import { Logger } from '../logger';
import db from '../service/db';
import { Student, Udict, User } from '../interface';
import * as bus from '../service/bus';
import { Value } from '../typeutils';
import UserModel from './user';

const coll = db.collection('stu.info');

const logger = new Logger('model/stuinfo');
const cache = new LRU<string, Student>({ max: 500, maxAge: 300 * 1000 });

export function deleteStudentCache(studoc: Student | string | undefined | null, receiver = false) {
    if (!studoc) return;
    if (!receiver) {
        bus.broadcast(
            'student/delcache',
            JSON.stringify(typeof studoc === 'string' ? studoc : pick(studoc, ['stuid', '_id'])),
        );
    }
    if (typeof studoc === 'string') {
        for (const key of cache.keys().filter((k) => k.endsWith(`/${studoc}`))) {
            cache.del(key);
        }
    } else {
        const id = [`uid/${studoc._id.toString()}`, `stuid/${studoc.stuid}`];
        for (const key of cache.keys().filter((k) => id.includes(k.split('/')[0]))) {
            cache.del(key);
        }
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

    static async getUserListByClassName(domain: string, cls: string): Promise<Udict> {
        const udocs: User[] = [];
        const cursor = coll.find({ class: cls }, { sort: { stuid: 1 } });
        // eslint-disable-next-line no-await-in-loop
        for (const student of await cursor.toArray()) udocs.push(await UserModel.getById(domain, student._id));
        return udocs;
    }

    static async getClassList(): Promise<string[]> {
        return await coll.distinct('class', { class: { $not: { $in: [null, ''] } } });
    }
}

global.Hydro.model.student = StudentModel;
export default StudentModel;
