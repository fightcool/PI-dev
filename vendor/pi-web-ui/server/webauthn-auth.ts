import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
  type AuthenticatorTransportFuture, type RegistrationResponseJSON, type AuthenticationResponseJSON,
} from "@simplewebauthn/server";

type Credential = { id: string; publicKey: string; counter: number; transports?: AuthenticatorTransportFuture[] };
type State = { credentials: Credential[]; challenges: Record<string,{challenge:string; expires:number}>; sessions: Record<string,{expires:number}>; recovery: string[] };
const empty = (): State => ({ credentials: [], challenges: {}, sessions: {}, recovery: [] });
const hash = (value: string) => createHash("sha256").update(value).digest("base64url");
/** 恢复码落盘前缀：只存哈希，不存明文（旧版明文条目在读时兼容并迁移）。 */
const RECOVERY_PREFIX = "sha256:";
const hashRecovery = (code: string) => `${RECOVERY_PREFIX}${hash(code)}`;
export class WebAuthnAuth {
  private state: State = empty();
  constructor(private readonly dir: string, private readonly rpID: string, private readonly origin: string) {}
  async load() { try { this.state = JSON.parse(await readFile(join(this.dir,"webauthn.json"),"utf8")); } catch { await this.persist(); } }
  private async persist() { await mkdir(this.dir,{recursive:true,mode:0o700}); await writeFile(join(this.dir,"webauthn.json"),JSON.stringify(this.state,null,2),{mode:0o600}); }
  private challenge(c:string) { this.state.challenges[c]={challenge:c,expires:Date.now()+300000}; }
  private consumeChallenge() { const entry=Object.entries(this.state.challenges).find(([,x])=>x.expires>Date.now()); if (!entry) return null; delete this.state.challenges[entry[0]]; return entry[1].challenge; }
  async registrationOptions() { if (this.state.credentials.length) throw Error("registration disabled"); const o=await generateRegistrationOptions({rpName:"PI Web UI",rpID:this.rpID,userName:"pi-user",userDisplayName:"PI User",attestationType:"none",authenticatorSelection:{residentKey:"required",userVerification:"required"}}); this.challenge(o.challenge); await this.persist(); return o; }
  async registration(body: RegistrationResponseJSON) { if (this.state.credentials.length) throw Error("registration disabled"); const c=this.consumeChallenge(); if(!c) throw Error("challenge expired"); const v=await verifyRegistrationResponse({response:body,expectedChallenge:c,expectedOrigin:this.origin,expectedRPID:this.rpID,requireUserVerification:true}); if(!v.verified||!v.registrationInfo) throw Error("verification failed"); const i=v.registrationInfo; this.state.credentials.push({id:i.credential.id,publicKey:Buffer.from(i.credential.publicKey).toString("base64url"),counter:i.credential.counter,transports:body.response?.transports}); await this.persist(); return {verified:true}; }
  async authenticationOptions() { const o=await generateAuthenticationOptions({rpID:this.rpID,userVerification:"required",allowCredentials:this.state.credentials.map(x=>({id:x.id,transports:x.transports}))}); this.challenge(o.challenge); await this.persist(); return o; }
  async authentication(body: AuthenticationResponseJSON) { const c=this.consumeChallenge(); const cr=this.state.credentials.find(x=>x.id===body.id); if(!c||!cr) throw Error("invalid challenge"); const v=await verifyAuthenticationResponse({response:body,expectedChallenge:c,expectedOrigin:this.origin,expectedRPID:this.rpID,credential:{id:cr.id,publicKey:Buffer.from(cr.publicKey,"base64url"),counter:cr.counter},requireUserVerification:true}); if(!v.verified) throw Error("verification failed"); cr.counter=v.authenticationInfo.newCounter; const token=randomBytes(32).toString("base64url"); this.state.sessions[hash(token)]={expires:Date.now()+86400000}; await this.persist(); return token; }
  /**
   * 消费一个恢复码（一次性）。只与哈希比较；旧版明文条目命中时立即迁移为哈希
   * （迁移失败也不影响本次登录：文件写失败时明文条目仍在，下次仍可用）。
   */
  async recovery(code:string) {
    const normalized = String(code ?? "").trim();
    if (!normalized) return null;
    let index = this.state.recovery.indexOf(hashRecovery(normalized));
    if (index < 0) index = this.state.recovery.indexOf(normalized); // 兼容旧版明文
    if (index < 0) return null;
    this.state.recovery.splice(index, 1);
    const token=randomBytes(32).toString("base64url");
    this.state.sessions[hash(token)]={expires:Date.now()+86400000};
    await this.persist();
    return token;
  }
  async revoke(token:string) { delete this.state.sessions[hash(token)]; await this.persist(); }
  valid(token:string) { const s=this.state.sessions[hash(token)]; return !!s&&s.expires>Date.now(); }
  /**
   * 生成恢复码（一次性明文返回，供操作人保存；落盘只存哈希）。
   * 已有码时抛错而不是回显：哈希不可逆，服务端无法再展示原文，
   * 需要重新查看只能重新生成（调用方应提示操作人丢弃旧码）。
   */
  async recoveryCodes() {
    if (this.state.recovery.length) throw new Error("recovery codes already exist; regenerate explicitly");
    const codes = Array.from({length:10},()=>randomUUID().replaceAll("-","").slice(0,16));
    this.state.recovery = codes.map(hashRecovery);
    await this.persist();
    return codes;
  }
}
