import{s as J,x as tt,y as A,f as Q,g as W,h as X,d as f,z as T,i as u,C as et,D as st,E as at,G as q,H as G,R as it,o as lt,l as R,a as Y,e as H,m as E,c as Z,n as B}from"../chunks/scheduler.d583122a.js";import{S as v,i as $,a as w,t as y,b as I,d as M,m as U,e as O,g as rt,c as ot}from"../chunks/index.6f9a916b.js";import{g as K}from"../chunks/navigation.873987b5.js";import{p as nt}from"../chunks/stores.09446431.js";import{L as ct}from"../chunks/Loader.dfc94093.js";import{p as ft}from"../chunks/index.f2bf1820.js";import{a as mt}from"../chunks/snackbar.76b9f199.js";import{K as ut}from"../chunks/index.9c9c4205.js";import{g as gt,t as ht}from"../chunks/db.1a03e27e.js";import{P as pt}from"../chunks/Progressbar.5614bbfc.js";function dt(o){let e,a;const r=o[15].default,s=tt(r,o,o[14],null);let t=[o[1],{class:o[0]}],l={};for(let i=0;i<t.length;i+=1)l=A(l,t[i]);return{c(){e=Q("p"),s&&s.c(),this.h()},l(i){e=W(i,"P",{class:!0});var c=X(e);s&&s.l(c),c.forEach(f),this.h()},h(){T(e,l)},m(i,c){u(i,e,c),s&&s.m(e,null),a=!0},p(i,[c]){s&&s.p&&(!a||c&16384)&&et(s,r,i,i[14],a?at(r,i[14],c,null):st(i[14]),null),T(e,l=gt(t,[c&2&&i[1],{class:i[0]}]))},i(i){a||(w(s,i),a=!0)},o(i){y(s,i),a=!1},d(i){i&&f(e),s&&s.d(i)}}}function xt(o,e,a){const r=["color","height","align","justify","italic","firstupper","upperClass","opacity","whitespace","size","space","weight"];let s=q(e,r),{$$slots:t={},$$scope:l}=e,{color:i="text-gray-900 dark:text-white"}=e,{height:c="normal"}=e,{align:g="left"}=e,{justify:m=!1}=e,{italic:h=!1}=e,{firstupper:p=!1}=e,{upperClass:P="first-line:uppercase first-line:tracking-widest first-letter:text-7xl first-letter:font-bold first-letter:text-gray-900 dark:first-letter:text-gray-100 first-letter:mr-3 first-letter:float-left"}=e,{opacity:d=void 0}=e,{whitespace:x="normal"}=e,{size:b="base"}=e,{space:_=void 0}=e,{weight:S="normal"}=e;const z={xs:"text-xs",sm:"text-sm",base:"text-base",lg:"text-lg",xl:"text-xl","2xl":"text-2xl","3xl":"text-3xl","4xl":"text-4xl","5xl":"text-5xl","6xl":"text-6xl","7xl":"text-7xl","8xl":"text-8xl","9xl":"text-9xl"},j={thin:"font-thin",extralight:"font-extralight",light:"font-light",normal:"font-normal",medium:"font-medium",semibold:"font-semibold",bold:"font-bold",extrabold:"font-extrabold",black:"font-black"},L={tighter:"tracking-tighter",tight:"tracking-tight",normal:"tracking-normal",wide:"tracking-wide",wider:"tracking-wider",widest:"tracking-widest"},k={normal:"leading-normal",relaxed:"leading-relaxed",loose:"leading-loose"},D={left:"text-left",center:"text-center",right:"text-right"},N={normal:"whitespace-normal",nowrap:"whitespace-nowrap",pre:"whitespace-pre",preline:"whitespace-pre-line",prewrap:"whitespace-pre-wrap"};let F=i.split(" ").map(n=>n.trim()).map(n=>n+"/"+String(d)).join(" "),C=ht(b&&z[b],d&&F||i&&i,c&&k[c],S&&j[S],_&&L[_],g&&D[g],m&&"text-justify",h&&"italic",p&&P,x&&N[x],e.class);return o.$$set=n=>{a(23,e=A(A({},e),G(n))),a(1,s=q(e,r)),"color"in n&&a(2,i=n.color),"height"in n&&a(3,c=n.height),"align"in n&&a(4,g=n.align),"justify"in n&&a(5,m=n.justify),"italic"in n&&a(6,h=n.italic),"firstupper"in n&&a(7,p=n.firstupper),"upperClass"in n&&a(8,P=n.upperClass),"opacity"in n&&a(9,d=n.opacity),"whitespace"in n&&a(10,x=n.whitespace),"size"in n&&a(11,b=n.size),"space"in n&&a(12,_=n.space),"weight"in n&&a(13,S=n.weight),"$$scope"in n&&a(14,l=n.$$scope)},e=G(e),[C,s,i,c,g,m,h,p,P,d,x,b,_,S,l,t]}class bt extends v{constructor(e){super(),$(this,e,xt,dt,J,{color:2,height:3,align:4,justify:5,italic:6,firstupper:7,upperClass:8,opacity:9,whitespace:10,size:11,space:12,weight:13})}}function _t(o){return[...new DOMParser().parseFromString(o,"text/html").getElementsByTagName("a")]}function V(o){let e,a,r,s;return e=new bt({props:{$$slots:{default:[wt]},$$scope:{ctx:o}}}),r=new pt({props:{progress:o[3]}}),{c(){I(e.$$.fragment),a=Y(),I(r.$$.fragment)},l(t){M(e.$$.fragment,t),a=Z(t),M(r.$$.fragment,t)},m(t,l){U(e,t,l),u(t,a,l),U(r,t,l),s=!0},p(t,l){const i={};l&4099&&(i.$$scope={dirty:l,ctx:t}),e.$set(i);const c={};l&8&&(c.progress=t[3]),r.$set(c)},i(t){s||(w(e.$$.fragment,t),w(r.$$.fragment,t),s=!0)},o(t){y(e.$$.fragment,t),y(r.$$.fragment,t),s=!1},d(t){t&&f(a),O(e,t),O(r,t)}}}function wt(o){let e,a,r;return{c(){e=R(o[0]),a=R(" / "),r=R(o[1])},l(s){e=E(s,o[0]),a=E(s," / "),r=E(s,o[1])},m(s,t){u(s,e,t),u(s,a,t),u(s,r,t)},p(s,t){t&1&&B(e,s[0]),t&2&&B(r,s[1])},d(s){s&&(f(e),f(a),f(r))}}}function kt(o){let e,a,r,s,t=o[0]&&o[3]!=="100"&&V(o);return{c(){e=R(o[2]),a=Y(),t&&t.c(),r=H()},l(l){e=E(l,o[2]),a=Z(l),t&&t.l(l),r=H()},m(l,i){u(l,e,i),u(l,a,i),t&&t.m(l,i),u(l,r,i),s=!0},p(l,i){(!s||i&4)&&B(e,l[2]),l[0]&&l[3]!=="100"?t?(t.p(l,i),i&9&&w(t,1)):(t=V(l),t.c(),w(t,1),t.m(r.parentNode,r)):t&&(rt(),y(t,1,1,()=>{t=null}),ot())},i(l){s||(w(t),s=!0)},o(l){y(t),s=!1},d(l){l&&(f(e),f(a),f(r)),t&&t.d(l)}}}function yt(o){let e,a,r;return a=new ct({props:{$$slots:{default:[kt]},$$scope:{ctx:o}}}),{c(){e=Q("div"),I(a.$$.fragment)},l(s){e=W(s,"DIV",{});var t=X(e);M(a.$$.fragment,t),t.forEach(f)},m(s,t){u(s,e,t),U(a,e,null),r=!0},p(s,[t]){const l={};t&4111&&(l.$$scope={dirty:t,ctx:s}),a.$set(l)},i(s){r||(w(a.$$.fragment,s),r=!0)},o(s){y(a.$$.fragment,s),r=!1},d(s){s&&f(e),O(a)}}}function Pt(o,e,a){let r,s;it(o,nt,x=>a(6,s=x));const t=s.url.searchParams.get("source")||"https://www.mokuro.moe/manga",l=s.url.searchParams.get("manga"),i=s.url.searchParams.get("volume"),c=`${t}/${l}/${i}`;let g="Loading...",m=[],h=0,p=0;async function P(){const b=await(await fetch(c+".mokuro",{cache:"no-store"})).blob(),_=new File([b],i+".mokuro",{type:b.type});Object.defineProperty(_,"webkitRelativePath",{value:"/"+i+".mokuro"});const z=await(await fetch(c+"/")).text(),j=_t(z);a(2,g="Downloading images...");const L=[".jpg",".jpeg",".png",".webp"];a(1,p=j.length);for(const k of j){const D=("."+k.pathname.split(".").at(-1)).toLowerCase();if(L.includes(D||"")){const F=await(await fetch(c+k.pathname)).blob(),C=new File([F],k.pathname.substring(1));Object.defineProperty(C,"webkitRelativePath",{value:"/"+i+k.pathname}),m.push(C)}a(0,h++,h)}m.push(_),m=m,a(2,g="Adding to catalog..."),ft(m).then(()=>{K("/",{replaceState:!0})})}function d(){K("/",{replaceState:!0})}return lt(()=>{!l||!i?(mt("Something went wrong"),d()):ut(`Import ${decodeURI(i||"")} into catalog?`,P,d)}),o.$$.update=()=>{o.$$.dirty&3&&a(3,r=Math.floor(h/p*100).toString())},[h,p,g,r,t]}class Bt extends v{constructor(e){super(),$(this,e,Pt,yt,J,{BASE_URL:4})}get BASE_URL(){return this.$$.ctx[4]}}export{Bt as component};
