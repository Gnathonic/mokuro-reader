import{F as J,s as Q,e as F,i as I,d as S,G as Y,Y as te,y as L,H as O,x as T,f as R,g as V,h as Z,ab as ue,X as Be,B as b,C as q,D as z,E as G,S as Fe,a4 as Ie,I as h,p as Ae,W as Pe,j as E,K as Te,_ as qe}from"./scheduler.d583122a.js";import{t as v,a as y,S as re,i as le,g as W,c as X,h as fe,b as ae,d as ne,m as ie,e as se}from"./index.6f9a916b.js";import{t as oe,g as de,a as Ne}from"./db.1a03e27e.js";function ce(t){return(t==null?void 0:t.length)!==void 0?t:Array.from(t)}function ot(t,e){t.d(1),e.delete(t.key)}function dt(t,e){v(t,1,1,()=>{e.delete(t.key)})}function ut(t,e,l,a,r,s,n,o,i,d,c,g){let _=t.length,C=s.length,m=_;const M={};for(;m--;)M[t[m].key]=m;const N=[],U=new Map,j=new Map,A=[];for(m=C;m--;){const k=g(r,s,m),p=l(k);let D=n.get(p);D?a&&A.push(()=>D.p(k,e)):(D=d(p,k),D.c()),U.set(p,N[m]=D),p in M&&j.set(p,Math.abs(m-M[p]))}const H=new Set,K=new Set;function P(k){y(k,1),k.m(o,c),n.set(k.key,k),c=k.first,C--}for(;_&&C;){const k=N[C-1],p=t[_-1],D=k.key,B=p.key;k===p?(c=k.first,_--,C--):U.has(B)?!n.has(D)||H.has(D)?P(k):K.has(B)?_--:j.get(D)>j.get(B)?(K.add(D),P(k)):(H.add(B),_--):(i(p,n),_--)}for(;_--;){const k=t[_];U.has(k.key)||i(k,n)}for(;C;)P(N[C-1]);return J(A),N}function ee(t){let e,l,a,r,s,n;const o=t[14].default,i=T(o,t,t[13],null);let d=[t[8],{class:t[7]},{role:t[6]}],c={};for(let g=0;g<d.length;g+=1)c=L(c,d[g]);return{c(){e=R(t[1]),i&&i.c(),this.h()},l(g){e=V(g,(t[1]||"null").toUpperCase(),{class:!0,role:!0});var _=Z(e);i&&i.l(_),_.forEach(S),this.h()},h(){ue(t[1])(e,c)},m(g,_){I(g,e,_),i&&i.m(e,null),t[20](e),r=!0,s||(n=[Be(l=t[4].call(null,e,t[5])),b(e,"click",t[15]),b(e,"mouseenter",t[16]),b(e,"mouseleave",t[17]),b(e,"focusin",t[18]),b(e,"focusout",t[19])],s=!0)},p(g,_){t=g,i&&i.p&&(!r||_&8192)&&q(i,o,t,t[13],r?G(o,t[13],_,null):z(t[13]),null),ue(t[1])(e,c=de(d,[_&256&&t[8],(!r||_&128)&&{class:t[7]},(!r||_&64)&&{role:t[6]}])),l&&Fe(l.update)&&_&32&&l.update.call(null,t[5])},i(g){r||(y(i,g),g&&Ie(()=>{r&&(a||(a=fe(e,t[2],t[3],!0)),a.run(1))}),r=!0)},o(g){v(i,g),g&&(a||(a=fe(e,t[2],t[3],!1)),a.run(0)),r=!1},d(g){g&&S(e),i&&i.d(g),t[20](null),g&&a&&a.end(),s=!1,J(n)}}}function ze(t){let e=t[1],l,a=!1,r,s=t[1]&&ee(t);return{c(){s&&s.c(),l=F()},l(n){s&&s.l(n),l=F()},m(n,o){s&&s.m(n,o),I(n,l,o),r=!0},p(n,[o]){n[1]?e?Q(e,n[1])?(s.d(1),s=ee(n),e=n[1],s.c(),a&&(a=!1,y(s)),s.m(l.parentNode,l)):(a&&(a=!1,y(s)),s.p(n,o)):(s=ee(n),e=n[1],s.c(),y(s),s.m(l.parentNode,l)):e&&(a=!0,W(),v(s,1,1,()=>{s=null,e=n[1],a=!1}),X())},i(n){r||(y(s,n),r=!0)},o(n){v(s,n),r=!1},d(n){n&&S(l),s&&s.d(n)}}}function Ge(t,e,l){const a=["tag","color","rounded","border","shadow","transition","params","node","use","options","role"];let r=Y(e,a),{$$slots:s={},$$scope:n}=e;const o=()=>({duration:0}),i=()=>{};te("background",!0);let{tag:d=r.href?"a":"div"}=e,{color:c="default"}=e,{rounded:g=!1}=e,{border:_=!1}=e,{shadow:C=!1}=e,{transition:m=o}=e,{params:M={}}=e,{node:N=void 0}=e,{use:U=i}=e,{options:j={}}=e,{role:A=void 0}=e;const H={gray:"bg-gray-50 dark:bg-gray-800",red:"bg-red-50 dark:bg-gray-800",yellow:"bg-yellow-50 dark:bg-gray-800 ",green:"bg-green-50 dark:bg-gray-800 ",indigo:"bg-indigo-50 dark:bg-gray-800 ",purple:"bg-purple-50 dark:bg-gray-800 ",pink:"bg-pink-50 dark:bg-gray-800 ",blue:"bg-blue-50 dark:bg-gray-800 ",light:"bg-gray-50 dark:bg-gray-700",dark:"bg-gray-50 dark:bg-gray-800",default:"bg-white dark:bg-gray-800",dropdown:"bg-white dark:bg-gray-700",navbar:"bg-white dark:bg-gray-900",navbarUl:"bg-gray-50 dark:bg-gray-800",form:"bg-gray-50 dark:bg-gray-700",primary:"bg-primary-50 dark:bg-gray-800 ",orange:"bg-orange-50 dark:bg-orange-800",none:""},K={gray:"text-gray-800 dark:text-gray-300",red:"text-red-800 dark:text-red-400",yellow:"text-yellow-800 dark:text-yellow-300",green:"text-green-800 dark:text-green-400",indigo:"text-indigo-800 dark:text-indigo-400",purple:"text-purple-800 dark:text-purple-400",pink:"text-pink-800 dark:text-pink-400",blue:"text-blue-800 dark:text-blue-400",light:"text-gray-700 dark:text-gray-300",dark:"text-gray-700 dark:text-gray-300",default:"text-gray-500 dark:text-gray-400",dropdown:"text-gray-700 dark:text-gray-200",navbar:"text-gray-700 dark:text-gray-200",navbarUl:"text-gray-700 dark:text-gray-400",form:"text-gray-900 dark:text-white",primary:"text-primary-800 dark:text-primary-400",orange:"text-orange-800 dark:text-orange-400",none:""},P={gray:"border-gray-300 dark:border-gray-800 divide-gray-300 dark:divide-gray-800",red:"border-red-300 dark:border-red-800 divide-red-300 dark:divide-red-800",yellow:"border-yellow-300 dark:border-yellow-800 divide-yellow-300 dark:divide-yellow-800",green:"border-green-300 dark:border-green-800 divide-green-300 dark:divide-green-800",indigo:"border-indigo-300 dark:border-indigo-800 divide-indigo-300 dark:divide-indigo-800",purple:"border-purple-300 dark:border-purple-800 divide-purple-300 dark:divide-purple-800",pink:"border-pink-300 dark:border-pink-800 divide-pink-300 dark:divide-pink-800",blue:"border-blue-300 dark:border-blue-800 divide-blue-300 dark:divide-blue-800",light:"border-gray-500 divide-gray-500",dark:"border-gray-500 divide-gray-500",default:"border-gray-200 dark:border-gray-700 divide-gray-200 dark:divide-gray-700",dropdown:"border-gray-100 dark:border-gray-600 divide-gray-100 dark:divide-gray-600",navbar:"border-gray-100 dark:border-gray-700 divide-gray-100 dark:divide-gray-700",navbarUl:"border-gray-100 dark:border-gray-700 divide-gray-100 dark:divide-gray-700",form:"border-gray-300 dark:border-gray-700 divide-gray-300 dark:divide-gray-700",primary:"border-primary-500 dark:border-primary-200  divide-primary-500 dark:divide-primary-200 ",orange:"border-orange-300 dark:border-orange-800 divide-orange-300 dark:divide-orange-800",none:""};let k;function p(f){h.call(this,t,f)}function D(f){h.call(this,t,f)}function B(f){h.call(this,t,f)}function w(f){h.call(this,t,f)}function x(f){h.call(this,t,f)}function $(f){Ae[f?"unshift":"push"](()=>{N=f,l(0,N)})}return t.$$set=f=>{l(26,e=L(L({},e),O(f))),l(8,r=Y(e,a)),"tag"in f&&l(1,d=f.tag),"color"in f&&l(9,c=f.color),"rounded"in f&&l(10,g=f.rounded),"border"in f&&l(11,_=f.border),"shadow"in f&&l(12,C=f.shadow),"transition"in f&&l(2,m=f.transition),"params"in f&&l(3,M=f.params),"node"in f&&l(0,N=f.node),"use"in f&&l(4,U=f.use),"options"in f&&l(5,j=f.options),"role"in f&&l(6,A=f.role),"$$scope"in f&&l(13,n=f.$$scope)},t.$$.update=()=>{t.$$.dirty&512&&l(9,c=c??"default"),t.$$.dirty&512&&te("color",c),l(7,k=oe(H[c],K[c],g&&"rounded-lg",_&&"border",P[c],C&&"shadow-md",e.class))},e=O(e),[N,d,m,M,U,j,A,k,r,c,g,_,C,n,s,p,D,B,w,x,$]}class He extends re{constructor(e){super(),le(this,e,Ge,ze,Q,{tag:1,color:9,rounded:10,border:11,shadow:12,transition:2,params:3,node:0,use:4,options:5,role:6})}}const Ke=t=>({item:t[0]&32}),ge=t=>({item:t[5]}),Oe=t=>({item:t[0]&32}),_e=t=>({item:t[5]}),We=t=>({item:t[0]&32}),me=t=>({item:t[5]});function Xe(t){let e,l,a,r,s;const n=t[14].default,o=T(n,t,t[13],ge);return{c(){e=R("button"),o&&o.c(),this.h()},l(i){e=V(i,"BUTTON",{type:!0,class:!0,"aria-current":!0});var d=Z(e);o&&o.l(d),d.forEach(S),this.h()},h(){E(e,"type","button"),E(e,"class",l="flex items-center text-left "+t[4]),e.disabled=t[2],E(e,"aria-current",t[1])},m(i,d){I(i,e,d),o&&o.m(e,null),a=!0,r||(s=[b(e,"blur",t[25]),b(e,"change",t[26]),b(e,"click",t[27]),b(e,"focus",t[28]),b(e,"keydown",t[29]),b(e,"keypress",t[30]),b(e,"keyup",t[31]),b(e,"mouseenter",t[32]),b(e,"mouseleave",t[33]),b(e,"mouseover",t[34])],r=!0)},p(i,d){o&&o.p&&(!a||d[0]&8224)&&q(o,n,i,i[13],a?G(n,i[13],d,Ke):z(i[13]),ge),(!a||d[0]&16&&l!==(l="flex items-center text-left "+i[4]))&&E(e,"class",l),(!a||d[0]&4)&&(e.disabled=i[2]),(!a||d[0]&2)&&E(e,"aria-current",i[1])},i(i){a||(y(o,i),a=!0)},o(i){v(o,i),a=!1},d(i){i&&S(e),o&&o.d(i),r=!1,J(s)}}}function Ye(t){let e,l,a,r,s;const n=t[14].default,o=T(n,t,t[13],_e);return{c(){e=R("a"),o&&o.c(),this.h()},l(i){e=V(i,"A",{href:!0,class:!0,"aria-current":!0});var d=Z(e);o&&o.l(d),d.forEach(S),this.h()},h(){E(e,"href",t[3]),E(e,"class",l="block "+t[4]),E(e,"aria-current",t[1])},m(i,d){I(i,e,d),o&&o.m(e,null),a=!0,r||(s=[b(e,"blur",t[15]),b(e,"change",t[16]),b(e,"click",t[17]),b(e,"focus",t[18]),b(e,"keydown",t[19]),b(e,"keypress",t[20]),b(e,"keyup",t[21]),b(e,"mouseenter",t[22]),b(e,"mouseleave",t[23]),b(e,"mouseover",t[24])],r=!0)},p(i,d){o&&o.p&&(!a||d[0]&8224)&&q(o,n,i,i[13],a?G(n,i[13],d,Oe):z(i[13]),_e),(!a||d[0]&8)&&E(e,"href",i[3]),(!a||d[0]&16&&l!==(l="block "+i[4]))&&E(e,"class",l),(!a||d[0]&2)&&E(e,"aria-current",i[1])},i(i){a||(y(o,i),a=!0)},o(i){v(o,i),a=!1},d(i){i&&S(e),o&&o.d(i),r=!1,J(s)}}}function Je(t){let e,l;const a=t[14].default,r=T(a,t,t[13],me);return{c(){e=R("li"),r&&r.c(),this.h()},l(s){e=V(s,"LI",{class:!0});var n=Z(e);r&&r.l(n),n.forEach(S),this.h()},h(){E(e,"class",t[4])},m(s,n){I(s,e,n),r&&r.m(e,null),l=!0},p(s,n){r&&r.p&&(!l||n[0]&8224)&&q(r,a,s,s[13],l?G(a,s[13],n,We):z(s[13]),me),(!l||n[0]&16)&&E(e,"class",s[4])},i(s){l||(y(r,s),l=!0)},o(s){v(r,s),l=!1},d(s){s&&S(e),r&&r.d(s)}}}function Qe(t){let e,l,a,r;const s=[Je,Ye,Xe],n=[];function o(i,d){return i[0]?i[3]?1:2:0}return e=o(t),l=n[e]=s[e](t),{c(){l.c(),a=F()},l(i){l.l(i),a=F()},m(i,d){n[e].m(i,d),I(i,a,d),r=!0},p(i,d){let c=e;e=o(i),e===c?n[e].p(i,d):(W(),v(n[c],1,1,()=>{n[c]=null}),X(),l=n[e],l?l.p(i,d):(l=n[e]=s[e](i),l.c()),y(l,1),l.m(a.parentNode,a))},i(i){r||(y(l),r=!0)},o(i){v(l),r=!1},d(i){i&&S(a),n[e].d(i)}}}function Re(t,e,l){let{$$slots:a={},$$scope:r}=e,{active:s=Pe("active")}=e,{current:n=!1}=e,{disabled:o=!1}=e,{href:i=""}=e,{currentClass:d="text-white bg-primary-700 dark:text-white dark:bg-gray-800"}=e,{normalClass:c=""}=e,{disabledClass:g="text-gray-900 bg-gray-100 dark:bg-gray-600 dark:text-gray-400"}=e,{focusClass:_="focus:z-40 focus:outline-none focus:ring-2 focus:ring-primary-700 focus:text-primary-700 dark:focus:ring-gray-500 dark:focus:text-white"}=e,{hoverClass:C="hover:bg-gray-100 hover:text-primary-700 dark:hover:bg-gray-600 dark:hover:text-white"}=e,{itemDefaultClass:m="py-2 px-4 w-full text-sm font-medium list-none first:rounded-t-lg last:rounded-b-lg"}=e;const M={current:d,normal:c,disabled:g};let N,U;function j(u){h.call(this,t,u)}function A(u){h.call(this,t,u)}function H(u){h.call(this,t,u)}function K(u){h.call(this,t,u)}function P(u){h.call(this,t,u)}function k(u){h.call(this,t,u)}function p(u){h.call(this,t,u)}function D(u){h.call(this,t,u)}function B(u){h.call(this,t,u)}function w(u){h.call(this,t,u)}function x(u){h.call(this,t,u)}function $(u){h.call(this,t,u)}function f(u){h.call(this,t,u)}function De(u){h.call(this,t,u)}function Ee(u){h.call(this,t,u)}function Se(u){h.call(this,t,u)}function Ue(u){h.call(this,t,u)}function Le(u){h.call(this,t,u)}function Me(u){h.call(this,t,u)}function je(u){h.call(this,t,u)}return t.$$set=u=>{l(5,e=L(L({},e),O(u))),"active"in u&&l(0,s=u.active),"current"in u&&l(1,n=u.current),"disabled"in u&&l(2,o=u.disabled),"href"in u&&l(3,i=u.href),"currentClass"in u&&l(6,d=u.currentClass),"normalClass"in u&&l(7,c=u.normalClass),"disabledClass"in u&&l(8,g=u.disabledClass),"focusClass"in u&&l(9,_=u.focusClass),"hoverClass"in u&&l(10,C=u.hoverClass),"itemDefaultClass"in u&&l(11,m=u.itemDefaultClass),"$$scope"in u&&l(13,r=u.$$scope)},t.$$.update=()=>{t.$$.dirty[0]&6&&l(12,N=o?"disabled":n?"current":"normal"),l(4,U=oe(m,M[N],s&&N==="disabled"&&"cursor-not-allowed",s&&N==="normal"&&C,s&&N==="normal"&&_,e.class))},e=O(e),[s,n,o,i,U,e,d,c,g,_,C,m,N,r,a,j,A,H,K,P,k,p,D,B,w,x,$,f,De,Ee,Se,Ue,Le,Me,je]}class pe extends re{constructor(e){super(),le(this,e,Re,Qe,Q,{active:0,current:1,disabled:2,href:3,currentClass:6,normalClass:7,disabledClass:8,focusClass:9,hoverClass:10,itemDefaultClass:11},null,[-1,-1])}}function he(t,e,l){const a=t.slice();return a[11]=e[l],a[13]=l,a}const Ve=t=>({item:t&1}),be=t=>({item:t[0][0]}),Ze=t=>({item:t&1}),ke=t=>({item:t[11],index:t[13]}),we=t=>({item:t&1}),ye=t=>({item:t[11],index:t[13]});function ve(t){let e;const l=t[6].default,a=T(l,t,t[9],be);return{c(){a&&a.c()},l(r){a&&a.l(r)},m(r,s){a&&a.m(r,s),e=!0},p(r,s){a&&a.p&&(!e||s&513)&&q(a,l,r,r[9],e?G(l,r[9],s,Ve):z(r[9]),be)},i(r){e||(y(a,r),e=!0)},o(r){v(a,r),e=!1},d(r){a&&a.d(r)}}}function xe(t){let e,l;function a(){return t[8](t[11])}return e=new pe({props:{active:t[1],index:t[13],$$slots:{default:[et]},$$scope:{ctx:t}}}),e.$on("click",a),{c(){ae(e.$$.fragment)},l(r){ne(e.$$.fragment,r)},m(r,s){ie(e,r,s),l=!0},p(r,s){t=r;const n={};s&2&&(n.active=t[1]),s&513&&(n.$$scope={dirty:s,ctx:t}),e.$set(n)},i(r){l||(y(e.$$.fragment,r),l=!0)},o(r){v(e.$$.fragment,r),l=!1},d(r){se(e,r)}}}function $e(t){let e,l;const a=[{active:t[1]},t[11],{index:t[13]}];function r(){return t[7](t[11])}let s={$$slots:{default:[tt]},$$scope:{ctx:t}};for(let n=0;n<a.length;n+=1)s=L(s,a[n]);return e=new pe({props:s}),e.$on("click",r),{c(){ae(e.$$.fragment)},l(n){ne(e.$$.fragment,n)},m(n,o){ie(e,n,o),l=!0},p(n,o){t=n;const i=o&3?de(a,[o&2&&{active:t[1]},o&1&&Ne(t[11]),a[2]]):{};o&513&&(i.$$scope={dirty:o,ctx:t}),e.$set(i)},i(n){l||(y(e.$$.fragment,n),l=!0)},o(n){v(e.$$.fragment,n),l=!1},d(n){se(e,n)}}}function et(t){let e;const l=t[6].default,a=T(l,t,t[9],ke);return{c(){a&&a.c()},l(r){a&&a.l(r)},m(r,s){a&&a.m(r,s),e=!0},p(r,s){a&&a.p&&(!e||s&513)&&q(a,l,r,r[9],e?G(l,r[9],s,Ze):z(r[9]),ke)},i(r){e||(y(a,r),e=!0)},o(r){v(a,r),e=!1},d(r){a&&a.d(r)}}}function tt(t){let e;const l=t[6].default,a=T(l,t,t[9],ye);return{c(){a&&a.c()},l(r){a&&a.l(r)},m(r,s){a&&a.m(r,s),e=!0},p(r,s){a&&a.p&&(!e||s&513)&&q(a,l,r,r[9],e?G(l,r[9],s,we):z(r[9]),ye)},i(r){e||(y(a,r),e=!0)},o(r){v(a,r),e=!1},d(r){a&&a.d(r)}}}function Ce(t){let e,l,a,r;const s=[$e,xe],n=[];function o(i,d){return typeof i[11]=="object"?0:1}return e=o(t),l=n[e]=s[e](t),{c(){l.c(),a=F()},l(i){l.l(i),a=F()},m(i,d){n[e].m(i,d),I(i,a,d),r=!0},p(i,d){let c=e;e=o(i),e===c?n[e].p(i,d):(W(),v(n[c],1,1,()=>{n[c]=null}),X(),l=n[e],l?l.p(i,d):(l=n[e]=s[e](i),l.c()),y(l,1),l.m(a.parentNode,a))},i(i){r||(y(l),r=!0)},o(i){v(l),r=!1},d(i){i&&S(a),n[e].d(i)}}}function rt(t){let e,l,a=ce(t[0]),r=[];for(let o=0;o<a.length;o+=1)r[o]=Ce(he(t,a,o));const s=o=>v(r[o],1,1,()=>{r[o]=null});let n=null;return a.length||(n=ve(t)),{c(){for(let o=0;o<r.length;o+=1)r[o].c();e=F(),n&&n.c()},l(o){for(let i=0;i<r.length;i+=1)r[i].l(o);e=F(),n&&n.l(o)},m(o,i){for(let d=0;d<r.length;d+=1)r[d]&&r[d].m(o,i);I(o,e,i),n&&n.m(o,i),l=!0},p(o,i){if(i&523){a=ce(o[0]);let d;for(d=0;d<a.length;d+=1){const c=he(o,a,d);r[d]?(r[d].p(c,i),y(r[d],1)):(r[d]=Ce(c),r[d].c(),y(r[d],1),r[d].m(e.parentNode,e))}for(W(),d=a.length;d<r.length;d+=1)s(d);X(),!a.length&&n?n.p(o,i):a.length?n&&(W(),v(n,1,1,()=>{n=null}),X()):(n=ve(o),n.c(),y(n,1),n.m(e.parentNode,e))}},i(o){if(!l){for(let i=0;i<a.length;i+=1)y(r[i]);l=!0}},o(o){r=r.filter(Boolean);for(let i=0;i<r.length;i+=1)v(r[i]);l=!1},d(o){o&&S(e),qe(r,o),n&&n.d(o)}}}function lt(t){let e,l;const a=[{tag:t[1]?"div":"ul"},t[4],{rounded:!0},{border:!0},{class:t[2]}];let r={$$slots:{default:[rt]},$$scope:{ctx:t}};for(let s=0;s<a.length;s+=1)r=L(r,a[s]);return e=new He({props:r}),{c(){ae(e.$$.fragment)},l(s){ne(e.$$.fragment,s)},m(s,n){ie(e,s,n),l=!0},p(s,[n]){const o=n&22?de(a,[n&2&&{tag:s[1]?"div":"ul"},n&16&&Ne(s[4]),a[2],a[3],n&4&&{class:s[2]}]):{};n&515&&(o.$$scope={dirty:n,ctx:s}),e.$set(o)},i(s){l||(y(e.$$.fragment,s),l=!0)},o(s){v(e.$$.fragment,s),l=!1},d(s){se(e,s)}}}function at(t,e,l){const a=["items","active","defaultClass"];let r=Y(e,a),{$$slots:s={},$$scope:n}=e;const o=Te();let{items:i=[]}=e,{active:d=!1}=e,{defaultClass:c="divide-y divide-gray-200 dark:divide-gray-600"}=e,g;const _=m=>o("click",m),C=m=>o("click",m);return t.$$set=m=>{l(10,e=L(L({},e),O(m))),l(4,r=Y(e,a)),"items"in m&&l(0,i=m.items),"active"in m&&l(1,d=m.active),"defaultClass"in m&&l(5,c=m.defaultClass),"$$scope"in m&&l(9,n=m.$$scope)},t.$$.update=()=>{t.$$.dirty&2&&te("active",d),l(2,g=oe(c,e.class))},e=O(e),[i,d,g,o,r,c,s,_,C,n]}class ft extends re{constructor(e){super(),le(this,e,at,lt,Q,{items:0,active:1,defaultClass:5})}}export{He as F,pe as L,ft as a,ot as d,ce as e,dt as o,ut as u};
