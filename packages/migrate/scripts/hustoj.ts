/* eslint-disable no-tabs */
/* eslint-disable no-await-in-loop */
import fs from 'fs-extra';
import { ObjectID } from 'mongodb';
import mysql from 'mysql';
import TurndownService from 'turndown';
import { STATUS } from '@hydrooj/utils/lib/status';
import { noop, Time } from '@hydrooj/utils/lib/utils';
import { addScript, Schema } from 'hydrooj';
import { NotFoundError } from 'hydrooj/src/error';
import { postJudge } from 'hydrooj/src/handler/judge';
import { RecordDoc } from 'hydrooj/src/interface';
import { buildContent } from 'hydrooj/src/lib/content';
import * as contest from 'hydrooj/src/model/contest';
import domain from 'hydrooj/src/model/domain';
import problem from 'hydrooj/src/model/problem';
import record from 'hydrooj/src/model/record';
import SolutionModel from 'hydrooj/src/model/solution';
import * as system from 'hydrooj/src/model/system';
import user from 'hydrooj/src/model/user';

const turndown = new TurndownService({
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
});

const statusMap = {
    4: STATUS.STATUS_ACCEPTED,
    5: STATUS.STATUS_WRONG_ANSWER,
    6: STATUS.STATUS_WRONG_ANSWER,
    7: STATUS.STATUS_TIME_LIMIT_EXCEEDED,
    8: STATUS.STATUS_MEMORY_LIMIT_EXCEEDED,
    9: STATUS.STATUS_OUTPUT_LIMIT_EXCEEDED,
    10: STATUS.STATUS_RUNTIME_ERROR,
    11: STATUS.STATUS_COMPILE_ERROR,
};
const langMap = {
    0: 'c',
    1: 'cc',
    2: 'pas',
    3: 'java',
    4: 'rb',
    5: 'bash',
    6: 'py',
    7: 'php',
    8: 'perl',
    9: 'cs',
    10: 'oc',
    11: 'fb',
    12: 'sc',
    13: 'cl',
    14: 'cl++',
    15: 'lua',
    16: 'js',
    17: 'go',
};
const nameMap = {
    'sample.in': 'sample0.in',
    'sample.out': 'sample0.out',
    'test.in': 'test0.in',
    'test.out': 'test0.out',
};
export async function run({
    host = 'localhost', port = 3306, name = 'jol',
    username, password, domainId, contestType = 'oi',
    dataDir, rerun = true, randomMail = false,
}, report: Function) {
    const src = mysql.createConnection({
        host,
        port,
        user: username,
        password,
        database: name,
    });
    await new Promise((resolve, reject) => {
        src.connect((err) => (err ? reject(err) : resolve(null)));
    });
    const query = (q: string | mysql.Query) => new Promise<[values: any[], fields: mysql.FieldInfo[]]>((res, rej) => {
        src.query(q, (err, val, fields) => {
            if (err) rej(err);
            else res([val, fields]);
        });
    });
    const target = await domain.get(domainId);
    if (!target) throw new NotFoundError(domainId);
    report({ message: 'Connected to database' });
    /*
        user_id     varchar 20	N	??????id????????????
        email       varchar 100	Y	??????E-mail
        submit      int     11	Y	??????????????????
        solved      int     11	Y	????????????
        defunct     char    1	N	???????????????Y/N???
        ip          varchar 20	N	????????????ip
        accesstime	datetime	Y	??????????????????
        volume      int     11	N	?????????????????????????????????????????????
        language    int     11	N	??????
        password    varchar	32	Y	??????????????????
        reg_time    datetime	Y	??????????????????
        nick        varchar	100	N	??????
        school      varchar	100	N	??????????????????
    */
    const uidMap: Record<string, number> = {};
    const [udocs] = await query('SELECT * FROM `users`');
    const precheck = await user.getMulti({ unameLower: { $in: udocs.map((u) => u.user_id.toLowerCase()) } }).toArray();
    if (precheck.length) throw new Error(`Conflict username: ${precheck.map((u) => u.unameLower).join(', ')}`);
    for (const udoc of udocs) {
        if (randomMail) delete udoc.email;
        let current = await user.getByEmail(domainId, udoc.email || `${udoc.user_id}@hustoj.local`);
        if (!current) current = await user.getByUname(domainId, udoc.user_id);
        if (current) {
            report({ message: `duplicate user with email ${udoc.email}: ${current.uname},${udoc.user_id}` });
            uidMap[udoc.user_id] = current._id;
        } else {
            const uid = await user.create(
                udoc.email || `${udoc.user_id}@hustoj.local`, udoc.user_id, '',
                null, udoc.ip, udoc.defunct === 'Y' ? 0 : system.get('default.priv'),
            );
            uidMap[udoc.user_id] = uid;
            await user.setById(uid, {
                loginat: udoc.accesstime,
                regat: udoc.reg_time,
                hash: udoc.password,
                salt: udoc.password,
                school: udoc.school || '',
                hashType: 'hust',
            });
            await domain.setUserInDomain(domainId, uid, {
                displayName: udoc.nick || '',
                school: udoc.school || '',
                nSubmit: udoc.submit,
                nAccept: 0,
            });
        }
    }

    const [admins] = await query("SELECT * FROM `privilege` WHERE `rightstr` = 'administrator'");
    for (const admin of admins) await domain.setUserRole(domainId, uidMap[admin.user_id], 'root');
    const adminUids = admins.map((admin) => uidMap[admin.user_id]);
    report({ message: 'user finished' });

    /*
        problem_id	int	11	N	?????????????????????
        title	varchar	200	N	??????
        description	text		Y	????????????
        inupt	text		Y	????????????
        output	text		Y	????????????
        sample_input	text		Y	????????????
        sample_output	text		Y	????????????
        spj	char	1	N	?????????????????????
        hint	text		Y	??????
        source	varchar	100	Y	??????
        in_date	datetime		Y	????????????
        time_limit	int	11	N	???????????????
        memory_limit	int	11	N	????????????(MByte)
        defunct	char	1	N	???????????????Y/N???
        accepted	int	11	Y	???ac??????
        submit	int	11	Y	???????????????
        solved	int	11	Y	??????????????????

        solution #optional
    */
    const pidMap: Record<string, number> = {};
    const [[{ 'count(*)': pcount }]] = await query('SELECT count(*) FROM `problem`');
    const step = 50;
    const pageCount = Math.ceil(pcount / step);
    for (let pageId = 0; pageId < pageCount; pageId++) {
        const [pdocs] = await query(`SELECT * FROM \`problem\` LIMIT ${pageId * step}, ${step}`);
        for (const pdoc of pdocs) {
            if (rerun) {
                const opdoc = await problem.get(domainId, `P${pdoc.problem_id}`);
                if (opdoc) pidMap[pdoc.problem_id] = opdoc.docId;
            }
            if (!pidMap[pdoc.problem_id]) {
                const pid = await problem.add(
                    domainId, `P${pdoc.problem_id}`,
                    pdoc.title, buildContent({
                        description: pdoc.description,
                        input: pdoc.input,
                        output: pdoc.output,
                        samples: [[pdoc.sample_input.trim(), pdoc.sample_output.trim()]],
                        hint: pdoc.hint,
                        source: pdoc.source,
                    }, 'html'),
                    1, pdoc.source.split(' ').map((i) => i.trim()).filter((i) => i), pdoc.defunct === 'Y',
                );
                pidMap[pdoc.problem_id] = pid;
            }
            const [cdoc] = await query(`SELECT * FROM \`privilege\` WHERE \`rightstr\` = 'p${pdoc.problem_id}'`);
            const maintainer = [];
            for (let i = 1; i < cdoc.length; i++) maintainer.push(uidMap[cdoc[i].user_id]);
            await problem.edit(domainId, pidMap[pdoc.problem_id], {
                nAccept: 0,
                nSubmit: pdoc.submit,
                config: `time: ${pdoc.time_limit}s\nmemory: ${pdoc.memory_limit}m`,
                owner: uidMap[cdoc[0]?.user_id] || 1,
                maintainer,
                html: true,
            });
            if (pdoc.solution) {
                const md = turndown.turndown(pdoc.solution);
                await SolutionModel.add(domainId, pidMap[pdoc.problem_id], 1, md);
            }
        }
    }
    report({ message: 'problem finished' });

    /*
        contest_id	int	11	N	??????id????????????
        title	varchar	255	Y	????????????
        start_time	datetime		Y	????????????(???????????????)
        end_time	datatime		Y	????????????(???????????????)
        defunct	char	1	N	???????????????Y/N???
        description	text		Y	?????????????????????????????????
        private	tinyint	4		??????/?????????0/1???
        langmask	int	11		??????
        password	char(16)			?????????????????????
        user_id	char(48)			??????????????????????????????
    */
    const tidMap: Record<string, string> = {};
    const [tdocs] = await query('SELECT * FROM `contest`');
    for (const tdoc of tdocs) {
        const [pdocs] = await query(`SELECT * FROM \`contest_problem\` WHERE \`contest_id\` = ${tdoc.contest_id}`);
        const pids = pdocs.map((i) => pidMap[i.problem_id]).filter((i) => i);
        const tid = await contest.add(
            domainId, tdoc.title, tdoc.description || 'Description',
            adminUids[0], contestType, tdoc.start_time, tdoc.end_time, pids, true,
            { _code: password },
        );
        tidMap[tdoc.contest_id] = tid.toHexString();
    }
    report({ message: 'contest finished' });

    /*
        solution	????????????????????????
        ?????????	??????	??????	??????????????????	??????
        solution_id	int	11	N	??????id????????????
        problem_id	int	11	N	??????id
        user_id	char	20	N	??????id
        time	int	11	N	???????????????
        memory	int	11	N	??????????????????
        in_date	datetime		N	????????????
        result	smallint	6	N	?????????4???AC???
        language	tinyint	4	N	??????
        ip	char	15	N	??????ip
        contest_id	int	11	Y	??????????????????
        valid	tinyint	4	N	?????????????????????
        num	tinyint	4	N	??????????????????????????????
        code_lenght	int	11	N	????????????
        judgetime	datetime		Y	????????????
        pass_rate	decimal	2	N	??????????????????OI??????????????????
        lint_error	int		N	?????????
        judger	char(16)		N	?????????
    */
    const [[{ 'count(*)': rcount }]] = await query('SELECT count(*) FROM `solution`');
    const rpageCount = Math.ceil(rcount / step);
    for (let pageId = 0; pageId < rpageCount; pageId++) {
        const [rdocs] = await query(`SELECT * FROM \`solution\` LIMIT ${pageId * step}, ${step}`);
        for (const rdoc of rdocs) {
            const data: RecordDoc = {
                status: statusMap[rdoc.result] || 0,
                _id: Time.getObjectID(rdoc.in_date, false),
                uid: uidMap[rdoc.user_id] || 0,
                code: "HustOJ didn't provide user code",
                lang: langMap[rdoc.language] || '',
                pid: pidMap[rdoc.problem_id] || 0,
                domainId,
                score: rdoc.pass_rate ? Math.ceil(rdoc.pass_rate * 100) : rdoc.result === 4 ? 100 : 0,
                time: rdoc.time || 0,
                memory: rdoc.memory || 0,
                judgeTexts: [],
                compilerTexts: [],
                testCases: [],
                judgeAt: new Date(),
                rejudged: false,
                judger: 1,
            };
            const [ceInfo] = await query(`SELECT \`error\` FROM \`compileinfo\` WHERE \`solution_id\` = ${rdoc.solution_id}`);
            if (ceInfo[0]?.error) data.judgeTexts.push(ceInfo[0].error);
            const [rtInfo] = await query(`SELECT \`error\` FROM \`runtimeinfo\` WHERE \`solution_id\` = ${rdoc.solution_id}`);
            if (rtInfo[0]?.error) data.judgeTexts.push(rtInfo[0].error);
            const [source] = await query(`SELECT \`source\` FROM \`source_code\` WHERE \`solution_id\` = ${rdoc.solution_id}`);
            if (source[0]?.source) data.code = source[0].source;
            if (rdoc.contest_id) {
                data.contest = new ObjectID(tidMap[rdoc.contest_id]);
                await contest.attend(domainId, data.contest, uidMap[rdoc.user_id]).catch(noop);
            }
            await record.coll.insertOne(data);
            await postJudge(data).catch((err) => report({ message: err.message }));
        }
    }
    report({ message: 'record finished' });

    src.end();

    if (!dataDir) return true;
    if (dataDir.endsWith('/')) dataDir = dataDir.slice(0, -1);
    const files = await fs.readdir(dataDir, { withFileTypes: true });
    for (const file of files) {
        if (!file.isDirectory()) continue;
        const datas = await fs.readdir(`${dataDir}/${file.name}`, { withFileTypes: true });
        const pdoc = await problem.get(domainId, `P${file.name}`, undefined, true);
        if (!pdoc) continue;
        report({ message: `Syncing testdata for ${file.name}` });
        for (const data of datas) {
            if (data.isDirectory()) continue;
            const filename = nameMap[data.name] || data;
            await problem.addTestdata(domainId, pdoc.docId, filename, `${dataDir}/${file.name}/${data.name}`);
        }
        await problem.addTestdata(domainId, pdoc.docId, 'config.yaml', Buffer.from(pdoc.config as string));
    }
    return true;
}

addScript('migrateHustoj', 'migrate from hustoj')
    .args(Schema.object({
        host: Schema.string().required(),
        port: Schema.number().required(),
        name: Schema.string().required(),
        username: Schema.string().required(),
        password: Schema.string().required(),
        domainId: Schema.string().required(),
        contestType: Schema.string().required(),
        dataDir: Schema.string().required(),
    })).action(run);
