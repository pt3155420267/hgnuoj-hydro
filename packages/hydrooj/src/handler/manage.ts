import { exec } from 'child_process';
import { inspect } from 'util';
import * as yaml from 'js-yaml';
import Schema from 'schemastery';
import * as check from '../check';
import { BadRequestError, ValidationError } from '../error';
import {
    isEmail, isPassword, isUname, validate,
} from '../lib/validator';
import { Logger } from '../logger';
import { PRIV, STATUS } from '../model/builtin';
import domain from '../model/domain';
import record from '../model/record';
import * as setting from '../model/setting';
import StudentModel from '../model/stuinfo';
import * as system from '../model/system';
import user from '../model/user';
import * as bus from '../service/bus';
import {
    Connection, ConnectionHandler, Handler,
    param, Route, Types,
} from '../service/server';
import { configSource, saveConfig, SystemSettings } from '../settings';
import * as judge from './judge';

const logger = new Logger('manage');

function set(key: string, value: any) {
    if (setting.SYSTEM_SETTINGS_BY_KEY[key]) {
        const s = setting.SYSTEM_SETTINGS_BY_KEY[key];
        if (s.flag & setting.FLAG_DISABLED) return undefined;
        if ((s.flag & setting.FLAG_SECRET) && !value) return undefined;
        if (s.type === 'boolean') {
            if (value === 'on') return true;
            return false;
        }
        if (s.type === 'number') {
            if (!Number.isSafeInteger(+value)) throw new ValidationError(key);
            return +value;
        }
        if (s.subType === 'yaml') {
            try {
                yaml.load(value);
            } catch (e) {
                throw new ValidationError(key);
            }
        }
        return value;
    }
    return undefined;
}

class SystemHandler extends Handler {
    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
    }
}

class SystemMainHandler extends SystemHandler {
    async get() {
        this.response.redirect = '/manage/dashboard';
    }
}

class SystemCheckConnHandler extends ConnectionHandler {
    id: string;

    async prepare() {
        this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        await this.check();
    }

    async check() {
        const log = (payload: any) => this.send({ type: 'log', payload });
        const warn = (payload: any) => this.send({ type: 'warn', payload });
        const error = (payload: any) => this.send({ type: 'error', payload });
        await check.start(this, log, warn, error, (id) => { this.id = id; });
    }

    async cleanup() {
        check.cancel(this.id);
    }
}

class SystemDashboardHandler extends SystemHandler {
    async get() {
        this.response.template = 'manage_dashboard.html';
    }

    async postRestart() {
        if (!process.env.pm_cwd) throw new BadRequestError('Not launched by pm2');
        exec(`pm2 reload "${process.env.name}"`);
        this.back();
    }
}

class SystemScriptHandler extends SystemHandler {
    async get() {
        this.response.template = 'manage_script.html';
        this.response.body.scripts = global.Hydro.script;
    }

    @param('id', Types.Name)
    @param('args', Types.Content, true)
    async post(domainId: string, id: string, raw = '{}') {
        if (!global.Hydro.script[id]) throw new ValidationError('id');
        let args = JSON.parse(raw);
        if (typeof global.Hydro.script[id].validate === 'function') {
            args = global.Hydro.script[id].validate(args);
        } else {
            logger.warn('You are using the legacy script validation API, which will be dropped in the future.');
            validate(global.Hydro.script[id].validate, args);
        }
        const rid = await record.add(domainId, -1, this.user._id, '-', id, false, raw);
        const report = (data) => judge.next({ domainId, rid, ...data });
        report({ message: `Running script: ${id} `, status: STATUS.STATUS_JUDGING });
        const start = Date.now();
        // Maybe async?
        global.Hydro.script[id].run(args, report)
            .then((ret: any) => {
                const time = new Date().getTime() - start;
                judge.end({
                    domainId,
                    rid,
                    status: STATUS.STATUS_ACCEPTED,
                    message: inspect(ret, false, 10, true),
                    judger: 1,
                    time,
                    memory: 0,
                });
            })
            .catch((err: Error) => {
                const time = new Date().getTime() - start;
                logger.error(err);
                judge.end({
                    domainId,
                    rid,
                    status: STATUS.STATUS_SYSTEM_ERROR,
                    message: `${err.message} \n${(err as any).params || []} \n${err.stack} `,
                    judger: 1,
                    time,
                    memory: 0,
                });
            });
        this.response.body = { rid };
        this.response.redirect = this.url('record_detail', { rid });
    }
}

class SystemSettingHandler extends SystemHandler {
    async get() {
        this.response.template = 'manage_setting.html';
        this.response.body.current = {};
        this.response.body.settings = setting.SYSTEM_SETTINGS;
        for (const s of this.response.body.settings) {
            this.response.body.current[s.key] = system.get(s.key);
        }
    }

    async post(args: any) {
        const tasks = [];
        const booleanKeys = args.booleanKeys || {};
        delete args.booleanKeys;
        for (const key in args) {
            if (typeof args[key] === 'object') {
                for (const subkey in args[key]) {
                    const val = set(`${key}.${subkey}`, args[key][subkey]);
                    if (val !== undefined) {
                        tasks.push(system.set(`${key}.${subkey}`, val));
                    }
                }
            }
        }
        for (const key in booleanKeys) {
            if (typeof booleanKeys[key] === 'object') {
                for (const subkey in booleanKeys[key]) {
                    if (!args[key][subkey]) tasks.push(system.set(`${key}.${subkey}`, false));
                }
            }
        }
        await Promise.all(tasks);
        await bus.broadcast('system/setting', args);
        this.back();
    }
}

class SystemConfigHandler extends SystemHandler {
    async get() {
        this.response.template = 'manage_config.html';
        this.response.body = {
            schema: Schema.intersect(SystemSettings).toJSON(),
            value: configSource,
        };
    }

    @param('value', Types.String)
    async post(domainId: string, value: string) {
        let config;
        try {
            config = yaml.load(value);
            Schema.intersect(SystemSettings)(config);
        } catch (e) {
            throw new ValidationError('value');
        }
        await saveConfig(config);
    }
}

class SystemUserImportHandler extends SystemHandler {
    async get() {
        this.response.body.users = [];
        this.response.template = 'manage_user_import.html';
    }

    @param('users', Types.Content)
    @param('draft', Types.Boolean)
    async post(domainId: string, _users: string, draft: boolean) {
        const users = _users.split('\n');
        const udocs = [];
        const messages = [];
        for (const i in users) {
            const u = users[i];
            if (!u.trim()) continue;
            let [email, username, password, displayName] = u.split(',').map((t) => t.trim());
            if (!email || !username || !password) [email, username, password, displayName] = u.split('\t').map((t) => t.trim());
            if (email && username && password) {
                if (!isEmail(email)) messages.push(`Line ${+i + 1}: Invalid email.`);
                else if (!isUname(username)) messages.push(`Line ${+i + 1}: Invalid username`);
                else if (!isPassword(password)) messages.push(`Line ${+i + 1}: Invalid password`);
                // eslint-disable-next-line no-await-in-loop
                else if (await user.getByEmail('system', email)) {
                    messages.push(`Line ${+i + 1}: Email ${email} already exists.`);
                    // eslint-disable-next-line no-await-in-loop
                } else if (await user.getByUname('system', username)) {
                    messages.push(`Line ${+i + 1}: Username ${username} already exists.`);
                } else {
                    udocs.push({
                        email, username, password, displayName,
                    });
                }
            } else messages.push(`Line ${+i + 1}: Input invalid.`);
        }
        messages.push(`${udocs.length} users found.`);
        if (!draft) {
            for (const {
                email, username, password, displayName,
            } of udocs) {
                try {
                    // eslint-disable-next-line no-await-in-loop
                    const uid = await user.create(email, username, password);
                    // eslint-disable-next-line no-await-in-loop
                    if (displayName) await domain.setUserInDomain(domainId, uid, { displayName });
                } catch (e) {
                    messages.push(e.message);
                }
            }
        }
        this.response.body.users = udocs;
        this.response.body.messages = messages;
    }
}

class SystemTeacherRegisterHandler extends SystemHandler {
    async get() {
        this.response.template = 'manage_teacher_register.html';
    }
 
    @param('teacherName', Types.String, (s) => /^[\u4E00-\u9FA5]{2,4}$/.test(s))
    @param('teacherID', Types.String)
    @param('email', Types.String, isEmail)
    @param('username', Types.String, isUname)
    @param('password', Types.String, isPassword)
    async post(domainId: string, teacherName:string, teacherID:string, email:string, username:string, password:string) {
        if (
            await user.getByEmail('system', email)
            || await user.getByUname('system', username)
            || await StudentModel.getStuInfoByStuId(teacherID)
        ) throw new BadRequestError('该用户已被注册！');
        const uid = await user.create(email, username, password);
        const udoc = await user.getById('system', uid);
        const addPriv:number = Math.sum(
            PRIV.PRIV_CREATE_DOMAIN,
            PRIV.PRIV_VIEW_JUDGE_STATISTICS,
            PRIV.PRIV_MOD_BADGE,
            PRIV.PRIV_READ_RECORD_CODE,
            PRIV.PRIV_REJUDGE,
            PRIV.PRIV_VIEW_HIDDEN_RECORD,
        );
        user.setPriv(uid, udoc.priv + addPriv);
        await StudentModel.create(uid, '老师', teacherName, teacherID);
        this.response.body.path.push(['manage_teacher_register']);
        this.back();
    }
}

class SystemStudentImportHandler extends SystemHandler {
    async get() {
        this.response.body.users = [];
        this.response.template = 'manage_stu_import.html';
    }
 
    @param('students', Types.Content)
    @param('draft', Types.Boolean)
    async post(domainId: string, students: string, draft: boolean) {
        const users = students.split('\n');
        const udocs = [];
        const messages = [];
        for (const i in users) {
            const u = users[i];
            if (!u.trim()) continue;
            let [email, username, password, realname, classname, stuid] = u.split(',').map((t) => t.trim());
            if (!email || !username || !password) [email, username, password, realname, classname, stuid] = u.split('\t').map((t) => t.trim());
            if (email && username && password) {
                if (!isEmail(email)) messages.push(`Line ${+i + 1}: Invalid email.`);
                else if (!isUname(username)) messages.push(`Line ${+i + 1}: Invalid username`);
                else if (!isPassword(password)) messages.push(`Line ${+i + 1}: Invalid password`);
                else if (!/^[0-9]*$/.test(stuid)) messages.push(`Line ${+i + 1}: Invalid stuid`);
                // eslint-disable-next-line no-await-in-loop
                else if (await user.getByEmail('system', email)) {
                    messages.push(`Line ${+i + 1}: Email ${email} already exists.`);
                    // eslint-disable-next-line no-await-in-loop
                } else if (await StudentModel.getStuInfoByStuId(stuid)) {
                    messages.push(`Line ${+i + 1}: stuid ${stuid} already been registered.`);
                // eslint-disable-next-line no-await-in-loop
                } else if (await user.getByUname('system', username)) {
                    messages.push(`Line ${+i + 1}: Username ${username} already exists.`);
                } else {
                    udocs.push({
                        email, username, password, realname, classname, stuid,
                    });
                }
            } else messages.push(`Line ${+i + 1}: Input invalid.`);
        }
        messages.push(`${udocs.length} students found.`);
        if (!draft) {
            for (const {
                email, username, password, realname, classname, stuid,
            } of udocs) {
                try {
                    // eslint-disable-next-line no-await-in-loop
                    const uid = await user.create(email, username, password);
                    // eslint-disable-next-line no-await-in-loop
                    await StudentModel.create(uid, classname, realname, stuid);
                } catch (e) {
                    messages.push(e.message);
                }
            }
        }
        this.response.body.users = udocs;
        this.response.body.messages = messages;
    }
}
 
 
class SystemChangeUserPasswordHandler extends SystemHandler {
    async get() {
        this.response.template = 'manage_user_changepassword.html';
    }
 
    @param('password', Types.String, isPassword)
    @param('confirmPassword', Types.String, isPassword)
    @param('userID', Types.Int, true)
    @param('email', Types.String, true, isEmail)
    @param('username', Types.String, true, isUname)
    @param('stuid', Types.String, true)
    async post(domainId: string, password:string, confirmPassword:string, userID?:number, email?:string, username?:string, stuid?:string) {
        let udoc = null;
        if (password !== confirmPassword) throw new BadRequestError('密码不一致！');
        if (userID) udoc = await user.getById('system', userID);
        else if (email) udoc = await user.getByEmail('system', email);
        else if (username) udoc = await user.getByUname('system', username);
        else if (stuid) udoc = await user.getById('system', (await StudentModel.getStuInfoByStuId(stuid))._id);
        else throw new BadRequestError('请填写用户信息！');
        if (!udoc) throw new BadRequestError('用户不存在！');
        await user.setPassword(udoc._id, password);
        this.back();
    }
}
 


async function apply() {
    Route('manage', '/manage', SystemMainHandler);
    Route('manage_dashboard', '/manage/dashboard', SystemDashboardHandler);
    Route('manage_script', '/manage/script', SystemScriptHandler);
    Route('manage_setting', '/manage/setting', SystemSettingHandler);
    Route('manage_config', '/manage/config', SystemConfigHandler);
    Route('manage_user_import', '/manage/userimport', SystemUserImportHandler);
    Route('manage_student_import', '/manage/studentimport', SystemStudentImportHandler);
    Route('manage_teacher_register', '/manage/teacher-reg', SystemTeacherRegisterHandler);
    Route('manage_user_changepassword', '/manage/change-password', SystemChangeUserPasswordHandler);
    Connection('manage_check', '/manage/check-conn', SystemCheckConnHandler);
}

global.Hydro.handler.manage = apply;
