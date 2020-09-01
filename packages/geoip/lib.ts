import 'hydrooj';
import fs from 'fs';
import path from 'path';
import { Reader } from 'maxmind';

const buffer = fs.readFileSync(path.resolve(__dirname, 'GeoLite2-City.mmdb'));
const reader = new Reader(buffer);

export interface Result {
    location?: string,
    continent?: string,
    country?: string,
    city?: string,
    display: string
}

export function lookup(ip: string, locale: string): any {
    const res: any = reader.get(ip);
    if (!res) return {};
    const ret: Result = { display: '' };
    if (res.location) ret.location = res.location;
    if (res.continent) ret.continent = res.continent.names[locale] || res.continent.names.en;
    if (res.country || res.registered_country) {
        ret.country = (res.country || res.registered_country).names[locale]
            || (res.country || res.registered_country).names.en;
    }
    if (res.city) ret.city = res.city.names[locale] || res.city.names.en;
    ret.display = `${ret.continent} ${ret.country}${ret.city ? ` ${ret.city}` : ''}`;
    return ret;
}

export const provider = '<a href="http://www.maxmind.com" target="_blank">MaxMind</a>';

global.Hydro.lib.geoip = { provider, lookup };