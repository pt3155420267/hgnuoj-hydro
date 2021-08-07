import { Collection } from 'mongodb';
import LRU from 'lru-cache';
import { PERM, PRIV } from './builtin';
import { ArgMethod } from '../utils';
import { UserNotFoundError } from '../error';
import { Logger } from '../logger';
import db from '../service/db';
import { Student } from '../interface';
import * as bus from '../service/bus';

const coll = db.collection('stu.info');

const logger = new Logger('model/stuinfo');
const cache = new LRU<string, Student>({ max: 500, maxAge: 300 * 1000 });

class StudentModel {
    @ArgMethod
    static async getStuInfoById(_id: number): Promise<Student | null> {
        // if (cache.has(`${_id}`)) return cache.get(`${_id}`);

        const studoc = await coll.findOne({ _id });
        console.log(_id);
        console.log(studoc);
        if (!studoc) return null;

        // cache.set(`${studoc._id}`, studoc);
        return studoc;
    }
}

global.Hydro.model.student = StudentModel;
export default StudentModel;
