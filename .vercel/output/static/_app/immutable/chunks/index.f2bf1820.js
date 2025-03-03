import{d as x,c as je}from"./db.1a03e27e.js";import{a as G}from"./snackbar.76b9f199.js";import{O as Ze,g as Ge,U as v,x as z,i as Ve,A as We,S as Xe,h as U,M as P,k as te,z as He,Z as ne,y as Re,w as Te,F as Ae,a as me,D as Oe,C as Be,o as Ke,n as $e,L as qe,P as Je,Q as Qe,R as et,H as De,G as he,v as tt,T as nt,W as at,l as st,E as it,m as rt,t as ot,j as ct,b as Fe,I as Se,X as lt,Y as ft}from"./index.9c9c4205.js";import{a as Et,b as ie,s as ut,t as h,E as be,i as dt,r as _t,u as gt,v as wt,w as pt,x as Rt,y as Tt,z as At,A as mt,C as Ot,j as Ie,k as Dt,l as ht,D as Ne,F as Ft,G as St}from"./zip-entry.fa66699e.js";async function bt(){navigator.storage&&navigator.storage.persist&&await navigator.storage.persist()}function En(n,e=2){if(n===0)return"0 B";const a=1024,t=e<0?0:e,s=["B","KB","MB","GB","TB","PB","EB","ZB","YB"],i=Math.floor(Math.log(n)/Math.log(a));return`${parseFloat((n/a**i).toFixed(t))} ${s[i]}`}function B(n,e){return e&&e.trim().toLowerCase()=="cp437"?Ze(n):new TextDecoder(e).decode(n)}const ae="File format is not recognized",It="End of central directory not found",Nt="End of Zip64 central directory locator not found",Ct="Central directory header not found",Lt="Local file header not found",xt="Zip64 extra field not found",Pt="File contains encrypted entry",Mt="Encryption method not supported",Ce="Compression method not supported",Le="Split zip file",xe="utf-8",Pe="cp437",yt=[[gt,U],[wt,U],[pt,U],[Rt,P]],Ut={[P]:{getValue:d,bytes:4},[U]:{getValue:K,bytes:8}};class kt{constructor(e,a={}){Object.assign(this,{reader:Et(e),options:a,config:Ge()})}async*getEntriesGenerator(e={}){const a=this;let{reader:t}=a;const{config:s}=a;if(await ie(t),(t.size===v||!t.readUint8Array)&&(t=new ut(await new Response(t.readable).blob()),await ie(t)),t.size<z)throw new Error(ae);t.chunkSize=Ve(s);const i=await Vt(t,We,t.size,z,P*16);if(!i){const D=await h(t,0,4),l=T(D);throw d(l)==Xe?new Error(Le):new Error(It)}const r=T(i);let c=d(r,12),o=d(r,16);const f=i.offset,E=R(r,20),_=f+z+E;let u=R(r,4);const M=t.lastDiskNumber||0;let F=R(r,6),S=R(r,8),p=0,C=0;if(o==U||c==U||S==P||F==P){const D=await h(t,i.offset-te,te),l=T(D);if(d(l,0)==He){o=K(l,8);let I=await h(t,o,ne,-1),A=T(I);const L=i.offset-te-ne;if(d(A,0)!=Re&&o!=L){const y=o;o=L,p=o-y,I=await h(t,o,ne,-1),A=T(I)}if(d(A,0)!=Re)throw new Error(Nt);u==P&&(u=d(A,16)),F==P&&(F=d(A,20)),S==P&&(S=K(A,32)),c==U&&(c=K(A,40)),o-=c}}if(o>=t.size&&(p=t.size-o-c-z,o=t.size-c-z),M!=u)throw new Error(Le);if(o<0)throw new Error(ae);let g=0,m=await h(t,o,c,F),w=T(m);if(c){const D=i.offset-c;if(d(w,g)!=Te&&o!=D){const l=o;o=D,p+=o-l,m=await h(t,o,c,F),w=T(m)}}const b=i.offset-o-(t.lastDiskOffset||0);if(c!=b&&b>=0&&(c=b,m=await h(t,o,c,F),w=T(m)),o<0||o>=t.size)throw new Error(ae);const V=O(a,e,"filenameEncoding"),k=O(a,e,"commentEncoding");for(let D=0;D<S;D++){const l=new vt(t,s,a.options);if(d(w,g)!=Te)throw new Error(Ct);ye(l,w,g+6);const I=!!l.bitFlag.languageEncodingFlag,A=g+46,L=A+l.filenameLength,y=L+l.extraFieldLength,j=R(w,g+4),X=j>>8==0,Z=j>>8==3,N=m.subarray(A,L),oe=R(w,g+32),ce=y+oe,q=m.subarray(y,ce),le=I,fe=I,J=d(w,g+38),Ee=X&&(Y(w,g+38)&Ae)==Ae||Z&&(J>>16&me)==me||N.length&&N[N.length-1]==Oe.charCodeAt(0),ve=Z&&(J>>16&Fe)==Fe,ue=d(w,g+42)+p;Object.assign(l,{versionMadeBy:j,msDosCompatible:X,compressedSize:0,uncompressedSize:0,commentLength:oe,directory:Ee,offset:ue,diskNumberStart:R(w,g+34),internalFileAttributes:R(w,g+36),externalFileAttributes:J,rawFilename:N,filenameUTF8:le,commentUTF8:fe,rawExtraField:m.subarray(L,y),executable:ve}),l.internalFileAttribute=l.internalFileAttributes,l.externalFileAttribute=l.externalFileAttributes;const de=O(a,e,"decodeText")||B,_e=le?xe:V||Pe,ge=fe?xe:k||Pe;let H=de(N,_e);H===v&&(H=B(N,_e));let Q=de(q,ge);Q===v&&(Q=B(q,ge)),Object.assign(l,{rawComment:q,filename:H,comment:Q,directory:Ee||H.endsWith(Oe)}),C=Math.max(ue,C),Ue(l,l,w,g+6),l.zipCrypto=l.encrypted&&!l.extraFieldAES;const ee=new be(l);ee.getData=(pe,Ye)=>l.getData(pe,ee,Ye),g=ce;const{onprogress:we}=e;if(we)try{await we(D+1,S,new be(l))}catch{}yield ee}const $=O(a,e,"extractPrependedData"),W=O(a,e,"extractAppendedData");return $&&(a.prependedData=C>0?await h(t,0,C):new Uint8Array),a.comment=E?await h(t,f+z,E):new Uint8Array,W&&(a.appendedData=_<t.size?await h(t,_,t.size-_):new Uint8Array),!0}async getEntries(e={}){const a=[];for await(const t of this.getEntriesGenerator(e))a.push(t);return a}async close(){}}class zt{constructor(e={}){const{readable:a,writable:t}=new TransformStream,s=new kt(a,e).getEntriesGenerator();this.readable=new ReadableStream({async pull(i){const{done:r,value:c}=await s.next();if(r)return i.close();const o={...c,readable:function(){const{readable:f,writable:E}=new TransformStream;if(c.getData)return c.getData(E),f}()};delete o.getData,i.enqueue(o)}}),this.writable=t}}class vt{constructor(e,a,t){Object.assign(this,{reader:e,config:a,options:t})}async getData(e,a,t={}){const s=this,{reader:i,offset:r,diskNumberStart:c,extraFieldAES:o,compressionMethod:f,config:E,bitFlag:_,signature:u,rawLastModDate:M,uncompressedSize:F,compressedSize:S}=s,p=a.localDirectory={},C=await h(i,r,30,c),g=T(C);let m=O(s,t,"password"),w=O(s,t,"rawPassword");const b=O(s,t,"passThrough");if(m=m&&m.length&&m,w=w&&w.length&&w,o&&o.originalCompressionMethod!=Be)throw new Error(Ce);if(f!=Ke&&f!=$e&&!b)throw new Error(Ce);if(d(g,0)!=qe)throw new Error(Lt);ye(p,g,4),p.rawExtraField=p.extraFieldLength?await h(i,r+30+p.filenameLength,p.extraFieldLength,c):new Uint8Array,Ue(s,p,g,4,!0),Object.assign(a,{lastAccessDate:p.lastAccessDate,creationDate:p.creationDate});const V=s.encrypted&&p.encrypted&&!b,k=V&&!o;if(b||(a.zipCrypto=k),V){if(!k&&o.strength===v)throw new Error(Mt);if(!m&&!w)throw new Error(Pt)}const $=r+30+p.filenameLength+p.extraFieldLength,W=S,D=i.readable;Object.assign(D,{diskNumberStart:c,offset:$,size:W});const l=O(s,t,"signal"),I=O(s,t,"checkPasswordOnly");I&&(e=new WritableStream),e=dt(e),await ie(e,b?S:F);const{writable:A}=e,{onstart:L,onprogress:y,onend:j}=t,X={options:{codecType:Je,password:m,rawPassword:w,zipCrypto:k,encryptionStrength:o&&o.strength,signed:O(s,t,"checkSignature")&&!b,passwordVerification:k&&(_.dataDescriptor?M>>>8&255:u>>>24&255),signature:u,compressed:f!=0&&!b,encrypted:s.encrypted&&!b,useWebWorkers:O(s,t,"useWebWorkers"),useCompressionStream:O(s,t,"useCompressionStream"),transferStreams:O(s,t,"transferStreams"),checkPasswordOnly:I},config:E,streamOptions:{signal:l,size:W,onstart:L,onprogress:y,onend:j}};let Z=0;try{({outputSize:Z}=await _t({readable:D,writable:A},X))}catch(N){if(!I||N.message!=Qe)throw N}finally{const N=O(s,t,"preventClose");A.size+=Z,!N&&!A.locked&&await A.getWriter().close()}return I?v:e.getData?e.getData():A}}function ye(n,e,a){const t=n.rawBitFlag=R(e,a+2),s=(t&Se)==Se,i=d(e,a+6);Object.assign(n,{encrypted:s,version:R(e,a),bitFlag:{level:(t&et)>>1,dataDescriptor:(t&De)==De,languageEncodingFlag:(t&he)==he},rawLastModDate:i,lastModDate:Wt(i),filenameLength:R(e,a+22),extraFieldLength:R(e,a+24)})}function Ue(n,e,a,t,s){const{rawExtraField:i}=e,r=e.extraField=new Map,c=T(new Uint8Array(i));let o=0;try{for(;o<i.length;){const C=R(c,o),g=R(c,o+2);r.set(C,{type:C,data:i.slice(o+4,o+4+g)}),o+=4+g}}catch{}const f=R(a,t+4);Object.assign(e,{signature:d(a,t+10),uncompressedSize:d(a,t+18),compressedSize:d(a,t+14)});const E=r.get(tt);E&&(Yt(E,e),e.extraFieldZip64=E);const _=r.get(nt);_&&(Me(_,At,Tt,e,n),e.extraFieldUnicodePath=_);const u=r.get(at);u&&(Me(u,Ot,mt,e,n),e.extraFieldUnicodeComment=u);const M=r.get(st);M?(jt(M,e,f),e.extraFieldAES=M):e.compressionMethod=f;const F=r.get(it);F&&(Zt(F,e),e.extraFieldNTFS=F);const S=r.get(rt);S&&(Gt(S,e,s),e.extraFieldExtendedTimestamp=S);const p=r.get(ot);p&&(e.extraFieldUSDZ=p)}function Yt(n,e){e.zip64=!0;const a=T(n.data),t=yt.filter(([s,i])=>e[s]==i);for(let s=0,i=0;s<t.length;s++){const[r,c]=t[s];if(e[r]==c){const o=Ut[c];e[r]=n[r]=o.getValue(a,i),i+=o.bytes}else if(n[r])throw new Error(xt)}}function Me(n,e,a,t,s){const i=T(n.data),r=new lt;r.append(s[a]);const c=T(new Uint8Array(4));c.setUint32(0,r.get(),!0);const o=d(i,1);Object.assign(n,{version:Y(i,0),[e]:B(n.data.subarray(5)),valid:!s.bitFlag.languageEncodingFlag&&o==d(c,0)}),n.valid&&(t[e]=n[e],t[e+"UTF8"]=!0)}function jt(n,e,a){const t=T(n.data),s=Y(t,4);Object.assign(n,{vendorVersion:Y(t,0),vendorId:Y(t,2),strength:s,originalCompressionMethod:a,compressionMethod:R(t,5)}),e.compressionMethod=n.compressionMethod}function Zt(n,e){const a=T(n.data);let t=4,s;try{for(;t<n.data.length&&!s;){const i=R(a,t),r=R(a,t+2);i==ct&&(s=n.data.slice(t+4,t+4+r)),t+=4+r}}catch{}try{if(s&&s.length==24){const i=T(s),r=i.getBigUint64(0,!0),c=i.getBigUint64(8,!0),o=i.getBigUint64(16,!0);Object.assign(n,{rawLastModDate:r,rawLastAccessDate:c,rawCreationDate:o});const f=se(r),E=se(c),_=se(o),u={lastModDate:f,lastAccessDate:E,creationDate:_};Object.assign(n,u),Object.assign(e,u)}}catch{}}function Gt(n,e,a){const t=T(n.data),s=Y(t,0),i=[],r=[];a?((s&1)==1&&(i.push(Ie),r.push(Ne)),(s&2)==2&&(i.push(Dt),r.push(Ft)),(s&4)==4&&(i.push(ht),r.push(St))):n.data.length>=5&&(i.push(Ie),r.push(Ne));let c=1;i.forEach((o,f)=>{if(n.data.length>=c+4){const E=d(t,c);e[o]=n[o]=new Date(E*1e3);const _=r[f];n[_]=E}c+=4})}async function Vt(n,e,a,t,s){const i=new Uint8Array(4),r=T(i);Xt(r,0,e);const c=t+s;return await o(t)||await o(Math.min(c,a));async function o(f){const E=a-f,_=await h(n,E,f);for(let u=_.length-t;u>=0;u--)if(_[u]==i[0]&&_[u+1]==i[1]&&_[u+2]==i[2]&&_[u+3]==i[3])return{offset:E+u,buffer:_.slice(u,u+t).buffer}}}function O(n,e,a){return e[a]===v?n.options[a]:e[a]}function Wt(n){const e=(n&4294901760)>>16,a=n&65535;try{return new Date(1980+((e&65024)>>9),((e&480)>>5)-1,e&31,(a&63488)>>11,(a&2016)>>5,(a&31)*2,0)}catch{}}function se(n){return new Date(Number(n/BigInt(1e4)-BigInt(116444736e5)))}function Y(n,e){return n.getUint8(e)}function R(n,e){return n.getUint16(e,!0)}function d(n,e){return n.getUint32(e,!0)}function K(n,e){return Number(n.getBigUint64(e,!0))}function Xt(n,e,a){n.setUint32(e,a,!0)}function T(n){return new DataView(n.buffer)}const Ht=["zip","cbz"],Bt=["image/jpeg","image/png","image/webp"];function Kt(n){const{webkitRelativePath:e,name:a}=n,t=a.split("."),s=t.length>1?t.pop():"",i=t.join(".");let r=i;return e&&(r=s&&s.length>0?e.split(".").slice(0,-1).join("."):e),{filename:i,ext:s,path:r}}async function $t(n){try{return new Promise((e,a)=>n.file(t=>{t.webkitRelativePath||Object.defineProperty(t,"webkitRelativePath",{value:n.fullPath.substring(1)}),e(t)},a))}catch(e){console.log(e)}}function re(n){var e,a;return((a=(e=n.split("."))==null?void 0:e.pop())==null?void 0:a.toLowerCase())??""}function qt(n){const e=n.lastIndexOf(".");return e>-1&&e>n.lastIndexOf("/")?n.slice(0,e):n}function Jt(n){return re(n)==="mokuro"}function Qt(n){return ft(n).startsWith("image/")||Bt.includes(re(n))}function en(n){return Ht.includes(re(n))}async function tn(n,e){if(n.isDirectory){const a=n.createReader();await new Promise(t=>{function s(){a.readEntries(async i=>{if(i.length>0){for(const r of i)r.isFile?e.push($t(r)):await tn(r,e);s()}else t()})}s()})}}async function ke(n,e,a){var s;const t=n[e];a&&t&&t.series_uuid&&t.mokuro_version&&t.volume_uuid&&t.series_title&&t.volume_title&&t.page_count&&(await bt(),await x.volumes.where("volume_uuid").equals(t.volume_uuid).first()||(G("adding "+t.volume_title+" to your catalog"),a.files&&(a.files=Object.fromEntries(Object.entries(a.files).sort(([r,c],[o,f])=>r.localeCompare(o,void 0,{numeric:!0,sensitivity:"base"})))),t.thumbnail=await je((s=a.files)==null?void 0:s[Object.keys(a.files)[0]]),await x.transaction("rw",x.volumes,async()=>{await x.volumes.add(t,t.volume_uuid)}),await x.transaction("rw",x.volumes_data,async()=>{await x.volumes_data.add(a,t.volume_uuid)})))}async function nn(n){const e=JSON.parse(await n.text());return{metadata:{mokuro_version:e.version,series_title:e.title,series_uuid:e.title_uuid,page_count:e.pages.length,character_count:e.chars,volume_title:e.volume,volume_uuid:e.volume_uuid},data:{volume_uuid:e.volume_uuid,pages:e.pages},titleUuid:e.title_uuid}}async function ze(n,e,a,t){Jt(n.file.name)?(await rn(n,e,a,t),G("processed mokuro "+n.file.name)):en(n.file.name)?(G("opening "+n.file.name,5e3),await an(n,a,e,t)):Qt(n.file.name)&&(await sn(n,a,e,t),G("processed image "+n.file.name))}async function an(n,e,a,t){var s;for await(const i of n.file.stream().pipeThrough(new zt))if(!i.directory&&i.readable){const r=await new Response(i.readable).blob(),c=new File([r],i.filename,{lastModified:((s=i.lastModified)==null?void 0:s.getTime())||Date.now()}),f={path:n.path===""?i.filename:`${n.path}/${i.filename}`,file:c};await ze(f,a,e,t)}}async function sn(n,e,a,t){var c;const s=n.path;if(!s)return;const i=n.file.name,r=Object.keys(e).find(o=>s.startsWith(o));if(!r){const o=s.split("/").slice(0,-1).join("/");t[o]||(t[o]={}),t[o][i]=n.file;return}if(!(!r||!i)&&(e[r].files||(e[r].files={}),e[r].files[i]=n.file,((c=e[r].pages)==null?void 0:c.length)===Object.keys(e[r].files).length)){const o=e[r];delete e[r],await ke(a,r,o)}}async function rn(n,e,a,t){var f;const s=qt(n.path),{metadata:i,data:r,titleUuid:c}=await nn(n.file);e[s]=i;const o=Object.keys(t).find(E=>E.startsWith(s));if(o&&t[o]){if(a[s]={...r,files:t[o]},delete t[o],((f=a[s].pages)==null?void 0:f.length)===Object.keys(a[s].files).length){const E=a[s];delete a[s],await ke(e,s,E)}}else a[s]={...r,files:{}}}async function un(n){const e={},a={},t={};let s=[];n.forEach(i=>{const r=Kt(i).path;s.push({path:r,file:i})}),s=s.sort((i,r)=>i.file.name.localeCompare(r.file.name,void 0,{numeric:!0}));for(const i of s)await ze(i,e,a,t);G("Files uploaded successfully"),x.processThumbnails(5)}export{En as f,un as p,tn as s};
