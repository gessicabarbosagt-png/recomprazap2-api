import * as crypto from 'crypto';

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  const raw = process.env.ENCRYPTION_KEY ?? 'recomprazap-chave-padrao-mude-em-producao-obrig';
  return crypto.createHash('sha256').update(raw).digest();
}

export function encriptar(texto: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(texto, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

export function decriptar(cifrado: string): string {
  const key = getKey();
  const partes = cifrado.split(':');
  if (partes.length !== 3) throw new Error('Token cifrado inválido');
  const [ivHex, tagHex, encHex] = partes;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
