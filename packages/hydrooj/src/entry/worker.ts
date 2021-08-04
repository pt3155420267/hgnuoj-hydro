/* eslint-disable no-await-in-loop */
/* eslint-disable import/no-dynamic-require */
import cac from 'cac';
import {
    locale, template, lib, service, model, handler, script, setting, uistatic,
    builtinLib, builtinScript, builtinHandler, builtinModel,
} from './common';
import options from '../options';
import * as bus from '../service/bus';
import db from '../service/db';
import { Logger } from '../logger';

const logger = new Logger('loader/worker');
const detail = cac().parse().options.loaderDetail;

export async function load() {
    const pending = global.addons;
    const fail = [];
    const active = [];
    if (detail) logger.info('start');
    require('../lib/i18n');
    require('../utils');
    require('../error');
    require('../options');
    if (detail) logger.info('finish: options');
    await Promise.all([
        locale(pending, fail),
        template(pending, fail),
        uistatic(pending, fail),
    ]);
    if (detail) logger.info('finish: locale/template/static');
    const opts = options();
    await db.start(opts);
    if (detail) logger.info('finish: db.connect');
    const modelSystem = require('../model/system');
    await modelSystem.runConfig();
    if (detail) logger.info('finish: config');
    const storage = require('../service/storage');
    await storage.start();
    if (detail) logger.info('finish: storage.connect');
    for (const i of builtinLib) {
        let t;
        try {
            t = require.resolve(`../lib/${i}`);
        } catch (e) {
            t = require.resolve(`@hydrooj/utils/lib/${i}`);
        }
        require(t);
    }
    if (detail) logger.info('finish: lib.builtin');
    await lib(pending, fail);
    if (detail) logger.info('finish: lib.extra');
    require('../service/gridfs');
    require('../service/monitor');
    if (detail) logger.info('finish: gridfs/monitor');
    const server = require('../service/server');
    await server.prepare();
    if (detail) logger.info('finish: server');
    await service(pending, fail);
    if (detail) logger.info('finish: service.extra');
    for (const i of builtinModel) require(`../model/${i}`);
    if (detail) logger.info('finish: model.builtin');
    for (const i of builtinHandler) require(`../handler/${i}`);
    if (detail) logger.info('finish: handler.builtin');
    await model(pending, fail);
    if (detail) logger.info('finish: model.extra');
    const modelSetting = require('../model/setting');
    await setting(pending, fail, modelSetting);
    if (detail) logger.info('finish: setting');
    await handler(pending, fail);
    if (detail) logger.info('finish: handler.extra');
    for (const i in global.Hydro.handler) await global.Hydro.handler[i]();
    if (detail) logger.info('finish: handler.apply');
    const notfound = require('../handler/notfound');
    await notfound.apply();
    for (const i of builtinScript) require(`../script/${i}`);
    if (detail) logger.info('finish: script.builtin');
    await script(pending, fail, active);
    if (detail) logger.info('finish: script.extra');
    await bus.serial('app/started');
    if (detail) logger.info('finish: bus.serial(start)');
    await server.start();
    if (detail) logger.info('finish: server.start');
    setInterval(() => {
        process.send({ event: 'stat', count: global.Hydro.stat.reqCount });
        global.Hydro.stat.reqCount = 0;
    }, 30 * 1000);
    return { active, fail };
}
