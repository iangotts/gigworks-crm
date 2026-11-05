import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(scryptCb);
const KEYLEN = 32;
const R = 8;
const P = 1;
// Stored form: scrypt$<logN>$<r>$<p>$<salt b64>$<hash b64>. The cost is stored with the hash,
// so it can be raised later without locking anyone out.
export async function hashPassword(password, logN) {
    const salt = randomBytes(16);
    const N = 2 ** logN;
    const hash = await scrypt(password, salt, KEYLEN, { N, r: R, p: P, maxmem: 256 * 1024 * 1024 });
    return `scrypt$${logN}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}
export async function verifyPassword(password, stored) {
    const parts = stored.split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt')
        return false;
    const [, logN, r, p, saltB64, hashB64] = parts;
    const expected = Buffer.from(hashB64, 'base64');
    const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, {
        N: 2 ** Number(logN),
        r: Number(r),
        p: Number(p),
        maxmem: 256 * 1024 * 1024,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}
// Used when the email is unknown, so a wrong email takes as long as a wrong password.
let dummy;
export function dummyHash(logN) {
    dummy ??= hashPassword(randomBytes(12).toString('hex'), logN);
    return dummy;
}
