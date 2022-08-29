import { PERM, PRIV } from '../model/builtin';

const trueChecker = () => true;
const Checker = (perm: bigint | bigint[], priv: number | number[], checker: Function = trueChecker) => (handler) => (
    checker(handler)
    && (perm ? handler.user.hasPerm(perm) : true)
    && (priv ? handler.user.hasPriv(priv) : true)
);
const buildChecker = (...permPrivChecker: Array<number | bigint | Function | number[] | bigint[]>) => {
    let _priv: number | number[];
    let _perm: bigint | bigint[];
    let checker: Function = trueChecker;
    for (const item of permPrivChecker) {
        if (typeof item === 'function') checker = item;
        else if (typeof item === 'number') _priv = item;
        else if (typeof item === 'bigint') _perm = item;
        else if (item instanceof Array) {
            if (typeof item[0] === 'number') _priv = item as number[];
            else _perm = item as bigint[];
        }
    }
    return Checker(_perm, _priv, checker);
};

export const Nav = (
    name: string, args: ((handler: any) => Record<string, any>) | Record<string, any> = {}, prefix: string,
    ...permPrivChecker: Array<number | bigint | Function>
) => {
    if (typeof args !== 'function') args = () => (args || {});
    const checker = buildChecker(...permPrivChecker);
    if (name.startsWith('@@')) {
        global.Hydro.ui.nodes.nav.splice(+name.split('@@')[1], 0, {
            name: name.split('@@')[2], args, prefix, checker,
        });
    } else {
        global.Hydro.ui.nodes.nav.push({
            name, args, prefix, checker,
        });
    }
};

export const ProblemAdd = (
    name: string, args: Record<string, any> = {}, icon = 'add', text = 'Create Problem',
) => {
    global.Hydro.ui.nodes.problem_add.push({
        name, args, icon, text,
    });
};

export const UserDropdown = (
    name: string, args: Record<string, any> = {}, ...permPrivChecker: Array<number | bigint | Function>
) => {
    global.Hydro.ui.nodes.user_dropdown.push({
        name, args: args || {}, checker: buildChecker(...permPrivChecker),
    });
};

Nav('homepage', {}, 'homepage');
Nav('problem_main', {}, 'problem', PERM.PERM_VIEW_PROBLEM);
Nav('training_main', {}, 'training', PERM.PERM_VIEW_TRAINING);
Nav('homework_main', {}, 'homework', PERM.PERM_VIEW_HOMEWORK);
Nav('contest_main', {}, 'contest', PERM.PERM_VIEW_CONTEST);
Nav('courses', {}, 'courses', PRIV.PRIV_USER_PROFILE);
Nav('record_main', {}, 'record');
Nav('ranking', {}, 'ranking', PERM.PERM_VIEW_RANKING);
Nav('discussion_main', {}, 'discussion', PERM.PERM_VIEW_DISCUSSION);
Nav('domain_dashboard', {}, 'domain', PERM.PERM_EDIT_DOMAIN);
Nav('manage_dashboard', {}, 'manage', PRIV.PRIV_EDIT_SYSTEM);
ProblemAdd('problem_create');

global.Hydro.ui.Nav = Nav;
global.Hydro.ui.ProblemAdd = ProblemAdd;
global.Hydro.ui.UserDropdown = UserDropdown;
