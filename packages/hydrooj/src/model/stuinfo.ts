import { Collection } from 'mongodb';
import LRU from 'lru-cache';
import { PERM, PRIV } from './builtin';
import { ArgMethod } from '../utils';
import { UserNotFoundError } from '../error';
import { Logger } from '../logger';
import db from '../service/db';
import { Student, Udict } from '../interface';
import * as bus from '../service/bus';
import { Value } from '../typeutils';
import UserModel from './user';

const coll = db.collection('stu.info');

const logger = new Logger('model/stuinfo');
const cache = new LRU<string, Student>({ max: 500, maxAge: 300 * 1000 });

class StudentModel {
    @ArgMethod
    static async getStuInfoById(_id: number): Promise<Student | null> {
        // if (cache.has(`${_id}`)) return cache.get(`${_id}`);
        const studoc = await coll.findOne({ _id });
        if (!studoc) return null;
        // cache.set(`${studoc._id}`, studoc);
        return studoc;
    }

    @ArgMethod
    static async getStuInfoByStuId(stuid: string): Promise<Student | null> {
        // if (cache.has(`${_id}`)) return cache.get(`${_id}`);
        const studoc = await coll.findOne({ stuid });
        if (!studoc) return null;
        // cache.set(`${studoc._id}`, studoc);
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
        const udocs = [];
        const students: Student[] = await coll.find({ class: cls }).toArray();
        // eslint-disable-next-line no-await-in-loop
        for (const student of students) udocs.push(await UserModel.getById('system', student._id));
        return udocs;
    }
}

global.Hydro.model.student = StudentModel;
export default StudentModel;
