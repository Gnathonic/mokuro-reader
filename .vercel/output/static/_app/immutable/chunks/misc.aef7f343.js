var Cr=Object.defineProperty;var Mr=(t,e,r)=>e in t?Cr(t,e,{enumerable:!0,configurable:!0,writable:!0,value:r}):t[e]=r;var $=(t,e,r)=>(Mr(t,typeof e!="symbol"?e+"":e,r),r);import{s as zt,e as dt,i as Pt,d as Re,G as mt,W as Er,y as Ne,H as gt,x as _r,f as Or,g as Dr,h as Ir,ab as vt,B as U,C as Ar,D as zr,E as Pr,F as Br,I as H,Z as P}from"./scheduler.d583122a.js";import{S as Fr,i as Rr,a as Bt,t as Ft}from"./index.6f9a916b.js";import{t as Nr,g as Lr,d as Rt,u as Zr}from"./db.1a03e27e.js";import{w as fe,j as q,r as Vr}from"./singletons.32ef462a.js";import{p as Le}from"./stores.09446431.js";const qr=!0,Wr=qr;function ze(t){let e,r,o,i,s,a;const d=t[10].default,m=_r(d,t,t[9],null);let h=[{type:r=t[0]?void 0:t[1]},{href:t[0]},{role:o=t[0]?"link":"button"},t[3],{class:t[2]}],g={};for(let c=0;c<h.length;c+=1)g=Ne(g,h[c]);return{c(){e=Or(t[0]?"a":"button"),m&&m.c(),this.h()},l(c){e=Dr(c,((t[0]?"a":"button")||"null").toUpperCase(),{type:!0,href:!0,role:!0,class:!0});var v=Ir(e);m&&m.l(v),v.forEach(Re),this.h()},h(){vt(t[0]?"a":"button")(e,g)},m(c,v){Pt(c,e,v),m&&m.m(e,null),i=!0,s||(a=[U(e,"click",t[11]),U(e,"change",t[12]),U(e,"keydown",t[13]),U(e,"keyup",t[14]),U(e,"touchstart",t[15]),U(e,"touchend",t[16]),U(e,"touchcancel",t[17]),U(e,"mouseenter",t[18]),U(e,"mouseleave",t[19])],s=!0)},p(c,v){m&&m.p&&(!i||v&512)&&Ar(m,d,c,c[9],i?Pr(d,c[9],v,null):zr(c[9]),null),vt(c[0]?"a":"button")(e,g=Lr(h,[(!i||v&3&&r!==(r=c[0]?void 0:c[1]))&&{type:r},(!i||v&1)&&{href:c[0]},(!i||v&1&&o!==(o=c[0]?"link":"button"))&&{role:o},v&8&&c[3],(!i||v&4)&&{class:c[2]}]))},i(c){i||(Bt(m,c),i=!0)},o(c){Ft(m,c),i=!1},d(c){c&&Re(e),m&&m.d(c),s=!1,Br(a)}}}function jr(t){let e=t[0]?"a":"button",r,o,i=(t[0]?"a":"button")&&ze(t);return{c(){i&&i.c(),r=dt()},l(s){i&&i.l(s),r=dt()},m(s,a){i&&i.m(s,a),Pt(s,r,a),o=!0},p(s,[a]){s[0],e?zt(e,s[0]?"a":"button")?(i.d(1),i=ze(s),e=s[0]?"a":"button",i.c(),i.m(r.parentNode,r)):i.p(s,a):(i=ze(s),e=s[0]?"a":"button",i.c(),i.m(r.parentNode,r))},i(s){o||(Bt(i,s),o=!0)},o(s){Ft(i,s),o=!1},d(s){s&&Re(r),i&&i.d(s)}}}function Yr(t,e,r){const o=["pill","outline","size","href","type","color","shadow"];let i=mt(e,o),{$$slots:s={},$$scope:a}=e;const d=Er("group");let{pill:m=!1}=e,{outline:h=!1}=e,{size:g=d?"sm":"md"}=e,{href:c=void 0}=e,{type:v="button"}=e,{color:p=d?h?"dark":"alternative":"primary"}=e,{shadow:T=!1}=e;const C={alternative:"text-gray-900 bg-white border border-gray-200 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-400 hover:text-primary-700 focus:text-primary-700 dark:focus:text-white dark:hover:text-white",blue:"text-white bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-700",dark:"text-white bg-gray-800 hover:bg-gray-900 dark:bg-gray-800 dark:hover:bg-gray-700",green:"text-white bg-green-700 hover:bg-green-800 dark:bg-green-600 dark:hover:bg-green-700",light:"text-gray-900 bg-white border border-gray-300 hover:bg-gray-100 dark:bg-gray-800 dark:text-white dark:border-gray-600 dark:hover:bg-gray-700 dark:hover:border-gray-600",primary:"text-white bg-primary-700 hover:bg-primary-800 dark:bg-primary-600 dark:hover:bg-primary-700",purple:"text-white bg-purple-700 hover:bg-purple-800 dark:bg-purple-600 dark:hover:bg-purple-700",red:"text-white bg-red-700 hover:bg-red-800 dark:bg-red-600 dark:hover:bg-red-700",yellow:"text-white bg-yellow-400 hover:bg-yellow-500 ",none:""},M={alternative:"focus:ring-gray-200 dark:focus:ring-gray-700",blue:"focus:ring-blue-300 dark:focus:ring-blue-800",dark:"focus:ring-gray-300 dark:focus:ring-gray-700",green:"focus:ring-green-300 dark:focus:ring-green-800",light:"focus:ring-gray-200 dark:focus:ring-gray-700",primary:"focus:ring-primary-300 dark:focus:ring-primary-800",purple:"focus:ring-purple-300 dark:focus:ring-purple-900",red:"focus:ring-red-300 dark:focus:ring-red-900",yellow:"focus:ring-yellow-300 dark:focus:ring-yellow-900",none:""},w={alternative:"shadow-gray-500/50 dark:shadow-gray-800/80",blue:"shadow-blue-500/50 dark:shadow-blue-800/80",dark:"shadow-gray-500/50 dark:shadow-gray-800/80",green:"shadow-green-500/50 dark:shadow-green-800/80",light:"shadow-gray-500/50 dark:shadow-gray-800/80",primary:"shadow-primary-500/50 dark:shadow-primary-800/80",purple:"shadow-purple-500/50 dark:shadow-purple-800/80",red:"shadow-red-500/50 dark:shadow-red-800/80 ",yellow:"shadow-yellow-500/50 dark:shadow-yellow-800/80 ",none:""},F={alternative:"text-gray-900 hover:text-white border border-gray-800 hover:bg-gray-900 focus:bg-gray-900 focus:text-white focus:ring-gray-300 dark:border-gray-600 dark:hover:text-white dark:hover:bg-gray-600 dark:focus:ring-gray-800",blue:"text-blue-700 hover:text-white border border-blue-700 hover:bg-blue-800 dark:border-blue-500 dark:text-blue-500 dark:hover:text-white dark:hover:bg-blue-600",dark:"text-gray-900 hover:text-white border border-gray-800 hover:bg-gray-900 focus:bg-gray-900 focus:text-white dark:border-gray-600 dark:hover:text-white dark:hover:bg-gray-600",green:"text-green-700 hover:text-white border border-green-700 hover:bg-green-800 dark:border-green-500 dark:text-green-500 dark:hover:text-white dark:hover:bg-green-600",light:"text-gray-500 hover:text-gray-900 bg-white border border-gray-200 dark:border-gray-600 dark:hover:text-white dark:text-gray-400 hover:bg-gray-50 dark:bg-gray-700 dark:hover:bg-gray-600",primary:"text-primary-700 hover:text-white border border-primary-700 hover:bg-primary-700 dark:border-primary-500 dark:text-primary-500 dark:hover:text-white dark:hover:bg-primary-600",purple:"text-purple-700 hover:text-white border border-purple-700 hover:bg-purple-800 dark:border-purple-400 dark:text-purple-400 dark:hover:text-white dark:hover:bg-purple-500",red:"text-red-700 hover:text-white border border-red-700 hover:bg-red-800 dark:border-red-500 dark:text-red-500 dark:hover:text-white dark:hover:bg-red-600",yellow:"text-yellow-400 hover:text-white border border-yellow-400 hover:bg-yellow-500 dark:border-yellow-300 dark:text-yellow-300 dark:hover:text-white dark:hover:bg-yellow-400",none:""},j={xs:"px-3 py-2 text-xs",sm:"px-4 py-2 text-sm",md:"px-5 py-2.5 text-sm",lg:"px-5 py-3 text-base",xl:"px-6 py-3.5 text-base"},K=()=>h||p==="alternative"||p==="light";let G;function L(y){H.call(this,t,y)}function z(y){H.call(this,t,y)}function Z(y){H.call(this,t,y)}function D(y){H.call(this,t,y)}function I(y){H.call(this,t,y)}function Y(y){H.call(this,t,y)}function E(y){H.call(this,t,y)}function A(y){H.call(this,t,y)}function ae(y){H.call(this,t,y)}return t.$$set=y=>{r(27,e=Ne(Ne({},e),gt(y))),r(3,i=mt(e,o)),"pill"in y&&r(4,m=y.pill),"outline"in y&&r(5,h=y.outline),"size"in y&&r(6,g=y.size),"href"in y&&r(0,c=y.href),"type"in y&&r(1,v=y.type),"color"in y&&r(7,p=y.color),"shadow"in y&&r(8,T=y.shadow),"$$scope"in y&&r(9,a=y.$$scope)},t.$$.update=()=>{r(2,G=Nr("text-center font-medium",d?"focus:ring-2":"focus:ring-4",d&&"focus:z-10",d||"focus:outline-none","inline-flex items-center justify-center "+j[g],h?F[p]:C[p],p==="alternative"&&(d?"dark:bg-gray-700 dark:text-white dark:border-gray-700 dark:hover:border-gray-600 dark:hover:bg-gray-600":"dark:bg-transparent dark:border-gray-600 dark:hover:border-gray-700"),h&&p==="dark"&&(d?"dark:text-white dark:border-white":"dark:text-gray-400 dark:border-gray-700"),M[p],K()&&d&&"border-l-0 first:border-l",d?m&&"first:rounded-l-full last:rounded-r-full"||"first:rounded-l-lg last:rounded-r-lg":m&&"rounded-full"||"rounded-lg",T&&"shadow-lg",T&&w[p],e.disabled&&"cursor-not-allowed opacity-50",e.class))},e=gt(e),[c,v,G,i,m,h,g,p,T,a,s,L,z,Z,D,I,Y,E,A,ae]}class no extends Fr{constructor(e){super(),Rr(this,e,Yr,jr,zt,{pill:4,outline:5,size:6,href:0,type:1,color:7,shadow:8})}}function Jr(t){return t&&t.__esModule&&Object.prototype.hasOwnProperty.call(t,"default")?t.default:t}var Te={exports:{}};Te.exports=Nt;Te.exports.addWheelListener=Nt;Te.exports.removeWheelListener=Ur;function Nt(t,e,r){t.addEventListener("wheel",e,r)}function Ur(t,e,r){t.removeEventListener("wheel",e,r)}var Hr=Te.exports,Ce={exports:{}},Kr=4,Gr=.001,Xr=1e-7,Qr=10,ce=11,we=1/(ce-1),$r=typeof Float32Array=="function";function Lt(t,e){return 1-3*e+3*t}function Zt(t,e){return 3*e-6*t}function Vt(t){return 3*t}function Se(t,e,r){return((Lt(e,r)*t+Zt(e,r))*t+Vt(e))*t}function qt(t,e,r){return 3*Lt(e,r)*t*t+2*Zt(e,r)*t+Vt(e)}function en(t,e,r,o,i){var s,a,d=0;do a=e+(r-e)/2,s=Se(a,o,i)-t,s>0?r=a:e=a;while(Math.abs(s)>Xr&&++d<Qr);return a}function tn(t,e,r,o){for(var i=0;i<Kr;++i){var s=qt(e,r,o);if(s===0)return e;var a=Se(e,r,o)-t;e-=a/s}return e}function rn(t){return t}var nn=function(e,r,o,i){if(!(0<=e&&e<=1&&0<=o&&o<=1))throw new Error("bezier x values must be in [0, 1] range");if(e===r&&o===i)return rn;for(var s=$r?new Float32Array(ce):new Array(ce),a=0;a<ce;++a)s[a]=Se(a*we,e,o);function d(m){for(var h=0,g=1,c=ce-1;g!==c&&s[g]<=m;++g)h+=we;--g;var v=(m-s[g])/(s[g+1]-s[g]),p=h+v*we,T=qt(p,e,o);return T>=Gr?tn(m,p,e,o):T===0?p:en(m,h,h+we,e,o)}return function(h){return h===0?0:h===1?1:Se(d(h),r,i)}},le=nn,ht={ease:le(.25,.1,.25,1),easeIn:le(.42,0,1,1),easeOut:le(0,0,.58,1),easeInOut:le(.42,0,.58,1),linear:le(0,0,1,1)};Ce.exports=on;Ce.exports.makeAggregateRaf=Wt;Ce.exports.sharedScheduler=Wt();function on(t,e,r){var o=Object.create(null),i=Object.create(null);r=r||{};var s=typeof r.easing=="function"?r.easing:ht[r.easing];s||(r.easing&&console.warn("Unknown easing function in amator: "+r.easing),s=ht.ease);var a=typeof r.step=="function"?r.step:pt,d=typeof r.done=="function"?r.done:pt,m=an(r.scheduler),h=Object.keys(e);h.forEach(function(w){o[w]=t[w],i[w]=e[w]-t[w]});var g=typeof r.duration=="number"?r.duration:400,c=Math.max(1,g*.06),v,p=0;return v=m.next(C),{cancel:T};function T(){m.cancel(v),v=0}function C(){var w=s(p/c);p+=1,M(w),p<=c?(v=m.next(C),a(t)):(v=0,setTimeout(function(){d(t)},0))}function M(w){h.forEach(function(F){t[F]=i[F]*w+o[F]})}}function pt(){}function an(t){if(!t){var e=typeof window<"u"&&window.requestAnimationFrame;return e?sn():un()}if(typeof t.next!="function")throw new Error("Scheduler is supposed to have next(cb) function");if(typeof t.cancel!="function")throw new Error("Scheduler is supposed to have cancel(handle) function");return t}function sn(){return{next:window.requestAnimationFrame.bind(window),cancel:window.cancelAnimationFrame.bind(window)}}function un(){return{next:function(t){return setTimeout(t,1e3/60)},cancel:function(t){return clearTimeout(t)}}}function Wt(){var t=new Set,e=new Set,r=0;return{next:i,cancel:i,clearAll:o};function o(){t.clear(),e.clear(),cancelAnimationFrame(r),r=0}function i(d){e.add(d),s()}function s(){r||(r=requestAnimationFrame(a))}function a(){r=0;var d=e;e=t,t=d,t.forEach(function(m){m()}),t.clear()}}var ln=Ce.exports,cn=function(e){dn(e);var r=fn(e);return e.on=r.on,e.off=r.off,e.fire=r.fire,e};function fn(t){var e=Object.create(null);return{on:function(r,o,i){if(typeof o!="function")throw new Error("callback is expected to be a function");var s=e[r];return s||(s=e[r]=[]),s.push({callback:o,ctx:i}),t},off:function(r,o){var i=typeof r>"u";if(i)return e=Object.create(null),t;if(e[r]){var s=typeof o!="function";if(s)delete e[r];else for(var a=e[r],d=0;d<a.length;++d)a[d].callback===o&&a.splice(d,1)}return t},fire:function(r){var o=e[r];if(!o)return t;var i;arguments.length>1&&(i=Array.prototype.splice.call(arguments,1));for(var s=0;s<o.length;++s){var a=o[s];a.callback.apply(a.ctx,i)}return t}}}function dn(t){if(!t)throw new Error("Eventify cannot use falsy object as events subject");for(var e=["on","fire","off"],r=0;r<e.length;++r)if(t.hasOwnProperty(e[r]))throw new Error("Subject cannot be eventified, since it already has property '"+e[r]+"'")}var mn=gn;function gn(t,e,r){typeof r!="object"&&(r={});var o=typeof r.minVelocity=="number"?r.minVelocity:5,i=typeof r.amplitude=="number"?r.amplitude:.25,s=typeof r.cancelAnimationFrame=="function"?r.cancelAnimationFrame:vn(),a=typeof r.requestAnimationFrame=="function"?r.requestAnimationFrame:hn(),d,m,h=342,g,c,v,p,T,C,M,w;return{start:j,stop:G,cancel:F};function F(){s(g),s(w)}function j(){d=t(),p=M=c=T=0,m=new Date,s(g),s(w),g=a(K)}function K(){var z=Date.now(),Z=z-m;m=z;var D=t(),I=D.x-d.x,Y=D.y-d.y;d=D;var E=1e3/(1+Z);c=.8*I*E+.2*c,T=.8*Y*E+.2*T,g=a(K)}function G(){s(g),s(w);var z=t();v=z.x,C=z.y,m=Date.now(),(c<-o||c>o)&&(p=i*c,v+=p),(T<-o||T>o)&&(M=i*T,C+=M),w=a(L)}function L(){var z=Date.now()-m,Z=!1,D=0,I=0;p&&(D=-p*Math.exp(-z/h),D>.5||D<-.5?Z=!0:D=p=0),M&&(I=-M*Math.exp(-z/h),I>.5||I<-.5?Z=!0:I=M=0),Z&&(e(v+D,C+I),w=a(L))}}function vn(){return typeof cancelAnimationFrame=="function"?cancelAnimationFrame:clearTimeout}function hn(){return typeof requestAnimationFrame=="function"?requestAnimationFrame:function(t){return setTimeout(t,16)}}var pn=yn;function yn(t){if(t)return{capture:bt,release:bt};var e,r,o,i=!1;return{capture:s,release:a};function s(d){i=!0,r=window.document.onselectstart,o=window.document.ondragstart,window.document.onselectstart=yt,e=d,e.ondragstart=yt}function a(){i&&(i=!1,window.document.onselectstart=r,e&&(e.ondragstart=o))}}function yt(t){return t.stopPropagation(),!1}function bt(){}var Pe,wt;function bn(){if(wt)return Pe;wt=1,Pe=t;function t(){this.x=0,this.y=0,this.scale=1}return Pe}var xe={exports:{}},xt;function wn(){if(xt)return xe.exports;xt=1,xe.exports=t,xe.exports.canAttach=e;function t(r,o){if(!e(r))throw new Error("svg element is required for svg.panzoom to work");var i=r.ownerSVGElement;if(!i)throw new Error("Do not apply panzoom to the root <svg> element. Use its child instead (e.g. <g></g>). As of March 2016 only FireFox supported transform on the root element");o.disableKeyboardInteraction||i.setAttribute("tabindex",0);var s={getBBox:d,getScreenCTM:m,getOwner:a,applyTransform:g,initTransform:h};return s;function a(){return i}function d(){var c=r.getBBox();return{left:c.x,top:c.y,width:c.width,height:c.height}}function m(){var c=i.getCTM();return c||i.getScreenCTM()}function h(c){var v=r.getCTM();v===null&&(v=document.createElementNS("http://www.w3.org/2000/svg","svg").createSVGMatrix()),c.x=v.e,c.y=v.f,c.scale=v.a,i.removeAttributeNS(null,"viewBox")}function g(c){r.setAttribute("transform","matrix("+c.scale+" 0 0 "+c.scale+" "+c.x+" "+c.y+")")}}function e(r){return r&&r.ownerSVGElement&&r.getCTM}return xe.exports}var ke={exports:{}},kt;function xn(){if(kt)return ke.exports;kt=1,ke.exports=t,ke.exports.canAttach=e;function t(r,o){var i=e(r);if(!i)throw new Error("panzoom requires DOM element to be attached to the DOM tree");var s=r.parentElement;r.scrollTop=0,o.disableKeyboardInteraction||s.setAttribute("tabindex",0);var a={getBBox:m,getOwner:d,applyTransform:h};return a;function d(){return s}function m(){return{left:0,top:0,width:r.clientWidth,height:r.clientHeight}}function h(g){r.style.transformOrigin="0 0 0",r.style.transform="matrix("+g.scale+", 0, 0, "+g.scale+", "+g.x+", "+g.y+")"}}function e(r){return r&&r.parentElement&&r.style}return ke.exports}var St=Hr,Be=ln,kn=cn,Sn=mn,jt=pn,Tn=jt(),Cn=jt(!0),Mn=bn(),Tt=wn(),Ct=xn(),En=1,_n=1.75,Mt=300,Et=200,On=Yt;function Yt(t,e){e=e||{};var r=e.controller;if(r||(Tt.canAttach(t)?r=Tt(t,e):Ct.canAttach(t)&&(r=Ct(t,e))),!r)throw new Error("Cannot create panzoom for the current type of dom element");var o=r.getOwner(),i={x:0,y:0},s=!1,a=new Mn;r.initTransform&&r.initTransform(a);var d=typeof e.filterKey=="function"?e.filterKey:oe,m=typeof e.pinchSpeed=="number"?e.pinchSpeed:1,h=e.bounds,g=typeof e.maxZoom=="number"?e.maxZoom:Number.POSITIVE_INFINITY,c=typeof e.minZoom=="number"?e.minZoom:0,v=typeof e.boundsPadding=="number"?e.boundsPadding:.05,p=typeof e.zoomDoubleClickSpeed=="number"?e.zoomDoubleClickSpeed:_n,T=e.beforeWheel||oe,C=e.beforeMouseDown||oe,M=typeof e.zoomSpeed=="number"?e.zoomSpeed:En,w=_t(e.transformOrigin),F=e.enableTextSelection?Cn:Tn;Dn(h),e.autocenter&&er();var j,K=0,G=0,L=0,z=null,Z=new Date,D,I=!1,Y=!1,E,A,ae,y,Ee,R;"smoothScroll"in e&&!e.smoothScroll?R=In():R=Sn(cr,vr,e.smoothScroll);var _e,ie,de,me=!1;Ue();var ge={dispose:hr,moveBy:ee,moveTo:Oe,smoothMoveTo:gr,centerOn:mr,zoomTo:ye,zoomAbs:ve,smoothZoom:pe,smoothZoomAbs:Sr,showRectangle:$t,pause:Gt,resume:Xt,isPaused:Qt,getTransform:tr,getMinZoom:rr,setMinZoom:nr,getMaxZoom:or,setMaxZoom:ar,getTransformOrigin:ir,setTransformOrigin:sr,getZoomSpeed:ur,setZoomSpeed:lr};kn(ge);var Ve=typeof e.initialX=="number"?e.initialX:a.x,qe=typeof e.initialY=="number"?e.initialY:a.y,We=typeof e.initialZoom=="number"?e.initialZoom:a.scale;return(Ve!=a.x||qe!=a.y||We!=a.scale)&&ve(Ve,qe,We),ge;function Gt(){He(),me=!0}function Xt(){me&&(Ue(),me=!1)}function Qt(){return me}function $t(n){var u=o.getBoundingClientRect(),l=X(u.width,u.height),f=n.right-n.left,b=n.bottom-n.top;if(!Number.isFinite(f)||!Number.isFinite(b))throw new Error("Invalid rectangle");var x=l.x/f,k=l.y/b,_=Math.min(x,k);a.x=-(n.left+f/2)*_+l.x/2,a.y=-(n.top+b/2)*_+l.y/2,a.scale=_}function X(n,u){if(r.getScreenCTM){var l=r.getScreenCTM(),f=l.a,b=l.d,x=l.e,k=l.f;i.x=n*f-x,i.y=u*b-k}else i.x=n,i.y=u;return i}function er(){var n,u,l=0,f=0,b=Ye();if(b)l=b.left,f=b.top,n=b.right-b.left,u=b.bottom-b.top;else{var x=o.getBoundingClientRect();n=x.width,u=x.height}var k=r.getBBox();if(!(k.width===0||k.height===0)){var _=u/k.height,re=n/k.width,Q=Math.min(re,_);a.x=-(k.left+k.width/2)*Q+n/2+l,a.y=-(k.top+k.height/2)*Q+u/2+f,a.scale=Q}}function tr(){return a}function rr(){return c}function nr(n){c=n}function or(){return g}function ar(n){g=n}function ir(){return w}function sr(n){w=_t(n)}function ur(){return M}function lr(n){if(!Number.isFinite(n))throw new Error("Zoom speed should be a number");M=n}function cr(){return{x:a.x,y:a.y}}function Oe(n,u){a.x=n,a.y=u,De(),te("pan"),Ie()}function je(n,u){Oe(a.x+n,a.y+u)}function De(){var n=Ye();if(n){var u=!1,l=fr(),f=n.left-l.right;return f>0&&(a.x+=f,u=!0),f=n.right-l.left,f<0&&(a.x+=f,u=!0),f=n.top-l.bottom,f>0&&(a.y+=f,u=!0),f=n.bottom-l.top,f<0&&(a.y+=f,u=!0),u}}function Ye(){if(h){if(typeof h=="boolean"){var n=o.getBoundingClientRect(),u=n.width,l=n.height;return{left:u*v,top:l*v,right:u*(1-v),bottom:l*(1-v)}}return h}}function fr(){var n=r.getBBox(),u=dr(n.left,n.top);return{left:u.x,top:u.y,right:n.width*a.scale+u.x,bottom:n.height*a.scale+u.y}}function dr(n,u){return{x:n*a.scale+a.x,y:u*a.scale+a.y}}function Ie(){s=!0,j=window.requestAnimationFrame(pr)}function Je(n,u,l){if(Fe(n)||Fe(u)||Fe(l))throw new Error("zoom requires valid numbers");var f=a.scale*l;if(f<c){if(a.scale===c)return;l=c/a.scale}if(f>g){if(a.scale===g)return;l=g/a.scale}var b=X(n,u);if(a.x=b.x-l*(b.x-a.x),a.y=b.y-l*(b.y-a.y),h&&v===1&&c===1)a.scale*=l,De();else{var x=De();x||(a.scale*=l)}te("zoom"),Ie()}function ve(n,u,l){var f=l/a.scale;Je(n,u,f)}function mr(n){var u=n.ownerSVGElement;if(!u)throw new Error("ui element is required to be within the scene");var l=n.getBoundingClientRect(),f=l.left+l.width/2,b=l.top+l.height/2,x=u.getBoundingClientRect(),k=x.width/2-f,_=x.height/2-b;ee(k,_,!0)}function gr(n,u){ee(n-a.x,u-a.y,!0)}function ee(n,u,l){if(!l)return je(n,u);_e&&_e.cancel();var f={x:0,y:0},b={x:n,y:u},x=0,k=0;_e=Be(f,b,{step:function(_){je(_.x-x,_.y-k),x=_.x,k=_.y}})}function vr(n,u){be(),Oe(n,u)}function hr(){He()}function Ue(){o.addEventListener("mousedown",rt,{passive:!1}),o.addEventListener("dblclick",tt,{passive:!1}),o.addEventListener("touchstart",Ge,{passive:!1}),o.addEventListener("keydown",Ke,{passive:!1}),St.addWheelListener(o,st,{passive:!1}),Ie()}function He(){St.removeWheelListener(o,st),o.removeEventListener("mousedown",rt),o.removeEventListener("keydown",Ke),o.removeEventListener("dblclick",tt),o.removeEventListener("touchstart",Ge),j&&(window.cancelAnimationFrame(j),j=0),R.cancel(),at(),it(),F.release(),Ae()}function pr(){s&&yr()}function yr(){s=!1,r.applyTransform(a),te("transform"),j=0}function Ke(n){var u=0,l=0,f=0;if(n.keyCode===38?l=1:n.keyCode===40?l=-1:n.keyCode===37?u=1:n.keyCode===39?u=-1:n.keyCode===189||n.keyCode===109?f=1:(n.keyCode===187||n.keyCode===107)&&(f=-1),!d(n,u,l,f)){if(u||l){n.preventDefault(),n.stopPropagation();var b=o.getBoundingClientRect(),x=Math.min(b.width,b.height),k=.05,_=x*k*u,re=x*k*l;ee(_,re)}if(f){var Q=ut(f*100),x=w?ue():br();ye(x.x,x.y,Q)}}}function br(){var n=o.getBoundingClientRect();return{x:n.width/2,y:n.height/2}}function Ge(n){if(wr(n),se(),n.touches.length===1)return kr(n,n.touches[0]);n.touches.length===2&&(Ee=et(n.touches[0],n.touches[1]),de=!0,Xe())}function wr(n){e.onTouch&&!e.onTouch(n)||(n.stopPropagation(),n.preventDefault())}function xr(n){se(),!(e.onDoubleClick&&!e.onDoubleClick(n))&&(n.preventDefault(),n.stopPropagation())}function kr(n){G=new Date;var u=n.touches[0],l=J(u);D=l;var f=X(l.x,l.y);E=f.x,A=f.y,ae=E,y=A,R.cancel(),Xe()}function Xe(){I||(I=!0,document.addEventListener("touchmove",Qe),document.addEventListener("touchend",he),document.addEventListener("touchcancel",he))}function Qe(n){if(n.touches.length===1){n.stopPropagation();var u=n.touches[0],l=J(u),f=X(l.x,l.y),b=f.x-E,x=f.y-A;b!==0&&x!==0&&lt(),E=f.x,A=f.y,ee(b,x)}else if(n.touches.length===2){de=!0;var k=n.touches[0],_=n.touches[1],re=et(k,_),Q=1+(re/Ee-1)*m,ct=J(k),ft=J(_);if(E=(ct.x+ft.x)/2,A=(ct.y+ft.y)/2,w){var l=ue();E=l.x,A=l.y}ye(E,A,Q),Ee=re,n.stopPropagation(),n.preventDefault()}}function se(){L&&(clearTimeout(L),L=0)}function $e(n){if(e.onClick){se();var u=E-ae,l=A-y,f=Math.sqrt(u*u+l*l);f>5||(L=setTimeout(function(){L=0,e.onClick(n)},Mt))}}function he(n){if(se(),n.touches.length>0){var u=J(n.touches[0]),l=X(u.x,u.y);E=l.x,A=l.y}else{var f=new Date;if(f-K<Mt)if(w){var u=ue();pe(u.x,u.y,p)}else pe(D.x,D.y,p);else f-G<Et&&$e(n);K=f,Ae(),it()}}function et(n,u){var l=n.clientX-u.clientX,f=n.clientY-u.clientY;return Math.sqrt(l*l+f*f)}function tt(n){xr(n);var u=J(n);w&&(u=ue()),pe(u.x,u.y,p)}function rt(n){if(se(),!C(n)){if(z=n,Z=new Date,I)return n.stopPropagation(),!1;var u=n.button===1&&window.event!==null||n.button===0;if(u){R.cancel();var l=J(n),f=X(l.x,l.y);return ae=E=f.x,y=A=f.y,document.addEventListener("mousemove",nt),document.addEventListener("mouseup",ot),F.capture(n.target||n.srcElement),!1}}}function nt(n){if(!I){lt();var u=J(n),l=X(u.x,u.y),f=l.x-E,b=l.y-A;E=l.x,A=l.y,ee(f,b)}}function ot(){var n=new Date;n-Z<Et&&$e(z),F.release(),Ae(),at()}function at(){document.removeEventListener("mousemove",nt),document.removeEventListener("mouseup",ot),Y=!1}function it(){document.removeEventListener("touchmove",Qe),document.removeEventListener("touchend",he),document.removeEventListener("touchcancel",he),Y=!1,de=!1,I=!1}function st(n){if(!T(n)){R.cancel();var u=n.deltaY;n.deltaMode>0&&(u*=100);var l=ut(u);if(l!==1){var f=w?ue():J(n);ye(f.x,f.y,l),n.preventDefault()}}}function J(n){var u,l,f=o.getBoundingClientRect();return u=n.clientX-f.left,l=n.clientY-f.top,{x:u,y:l}}function pe(n,u,l){var f=a.scale,b={scale:f},x={scale:l*f};R.cancel(),be(),ie=Be(b,x,{step:function(k){ve(n,u,k.scale)},done:Tr})}function Sr(n,u,l){var f=a.scale,b={scale:f},x={scale:l};R.cancel(),be(),ie=Be(b,x,{step:function(k){ve(n,u,k.scale)}})}function ue(){var n=o.getBoundingClientRect();return{x:n.width*w.x,y:n.height*w.y}}function ye(n,u,l){return R.cancel(),be(),Je(n,u,l)}function be(){ie&&(ie.cancel(),ie=null)}function ut(n){var u=Math.sign(n),l=Math.min(.25,Math.abs(M*n/128));return 1-u*l}function lt(){Y||(te("panstart"),Y=!0,R.start())}function Ae(){Y&&(de||R.stop(),te("panend"))}function Tr(){te("zoomend")}function te(n){ge.fire(n,ge)}}function _t(t){if(t){if(typeof t=="object")return(!ne(t.x)||!ne(t.y))&&Ot(t),t;Ot()}}function Ot(t){throw console.error(t),new Error(["Cannot parse transform origin.","Some good examples:",'  "center center" can be achieved with {x: 0.5, y: 0.5}','  "top center" can be achieved with {x: 0.5, y: 0}','  "bottom right" can be achieved with {x: 1, y: 1}'].join(`
`))}function oe(){}function Dn(t){var e=typeof t;if(!(e==="undefined"||e==="boolean")){var r=ne(t.left)&&ne(t.top)&&ne(t.bottom)&&ne(t.right);if(!r)throw new Error("Bounds object is not valid. It can be: undefined, boolean (true|false) or an object {left, top, right, bottom}")}}function ne(t){return Number.isFinite(t)}function Fe(t){return Number.isNaN?Number.isNaN(t):t!==t}function In(){return{start:oe,stop:oe,cancel:oe}}function An(){if(typeof document>"u")return;var t=document.getElementsByTagName("script");if(!t)return;for(var e,r=0;r<t.length;++r){var o=t[r];if(o.src&&o.src.match(/\bpanzoom(\.min)?\.js/)){e=o;break}}if(!e)return;var i=e.getAttribute("query");if(!i)return;var s=e.getAttribute("name")||"pz",a=Date.now();d();function d(){var g=document.querySelector(i);if(!g){var c=Date.now(),v=c-a;if(v<2e3){setTimeout(d,100);return}console.error("Cannot find the panzoom element",s);return}var p=m(e);console.log(p),window[s]=Yt(g,p)}function m(g){for(var c=g.attributes,v={},p=0;p<c.length;++p){var T=c[p],C=h(T);C&&(v[C.name]=C.value)}return v}function h(g){if(g.name){var c=g.name[0]==="p"&&g.name[1]==="z"&&g.name[2]==="-";if(c){var v=g.name.substr(3),p=JSON.parse(g.value);return{name:v,value:p}}}}}An();const zn=Jr(On);let S,N;const Pn=fe(void 0);function oo(t){N=t,S=zn(t,{bounds:!1,maxZoom:10,minZoom:.1,zoomDoubleClickSpeed:1,enableTextSelection:!0,beforeMouseDown:e=>e.target.nodeName==="P",beforeWheel:e=>e.altKey,onTouch:e=>e.touches.length>1,filterKey:e=>{if(e.key==="ArrowLeft"||e.key==="ArrowRight"||e.key==="ArrowUp"||e.key==="ArrowDown")return!0}}),Pn.set(S),S.on("pan",()=>Dt()),S.on("zoom",()=>Dt())}function Me(t,e){if(!S||!N)return;const{scale:r}=S.getTransform(),{innerWidth:o,innerHeight:i}=window,{offsetWidth:s,offsetHeight:a}=N;let d=0,m=0;switch(t){case"left":d=0;break;case"center":d=(o-s*r)/2;break;case"right":d=o-s*r;break}switch(e){case"top":m=0;break;case"center":m=(i-a*r)/2;break;case"bottom":m=i-a*r;break}S.pause(),S.moveTo(d,m),S.resume()}function Bn(){S==null||S.moveTo(0,0),S==null||S.zoomTo(0,0,1/S.getTransform().scale),Me("center","center")}function Fn(){if(!S||!N)return;const{innerWidth:t}=window,e=1/S.getTransform().scale*(t/N.offsetWidth);S.moveTo(0,0),S.zoomTo(0,0,e),Me("center","top")}function Rn(){if(!S||!N)return;const{innerWidth:t,innerHeight:e}=window,r=t/N.offsetWidth,o=e/N.offsetHeight,i=1/S.getTransform().scale*Math.min(r,o);S.moveTo(0,0),S.zoomTo(0,0,i),Me("center","center")}function Nn(){Me("center","top")}function Ln(){switch(P(Ht).zoomDefault){case"zoomFitToScreen":Rn();return;case"zoomFitToWidth":Fn();return;case"zoomOriginal":Bn();return;case"keepZoomStart":Nn();return}}function Dt(){if(!S||!N)return;const{mobile:t,bounds:e}=P(Ht);if(!t&&!e)return;const r=S.getTransform(),{x:o,y:i,scale:s}=r,{innerWidth:a,innerHeight:d}=window,m=N.offsetWidth*s,h=N.offsetHeight*s,g=a*.001,c=d*.01;let v=a-m-g,p=g,T=d-h-c,C=c,M=!1;m+2*g<=a?(v=g,p=a-m-g):(v=a-m-g,p=g),h+2*c<=d?(T=c,C=d-h-c,M=!0):(T=d-h-c,C=c),o<v&&(r.x=v),o>p&&(r.x=p),M?r.y=d/2-h/2:(i<T&&(r.y=T),i>C&&(r.y=C))}function ao(){document.fullscreenElement?document.exitFullscreen&&document.exitFullscreen():document.documentElement.requestFullscreen()}function Zn(t,e){return t.title.localeCompare(e.title,void 0,{sensitivity:"base"})}function Vn(t){const e=new Map;for(const o of t){let i=e.get(o.series_uuid);i===void 0&&(i={title:o.series_title,series_uuid:o.series_uuid,volumes:[]},e.set(o.series_uuid,i)),i.volumes.push(o)}const r=Array.from(e.values());for(const o of r)o.volumes;return r.sort(Zn),r}function qn(t,e){return t.volume_title<e.volume_title?-1:t.volume_title>e.volume_title?1:0}const Jt=Vr({},t=>{const e=Zr(async()=>(await Rt.volumes.toArray()).reduce((o,i)=>(o[i.volume_uuid]=i,o),{})).subscribe({next:r=>t(r),error:r=>console.error(r)});return()=>e.unsubscribe()}),Wn=q([Jt],([t])=>Vn(Object.values(t))),jn=q([Le,Wn],([t,e])=>{var r;return(((r=e.find(o=>o.series_uuid===t.params.manga))==null?void 0:r.volumes)||[]).sort(qn)}),Ut=q([Le,Jt],([t,e])=>{if(t&&e)return e[t.params.volume]}),io=q([Ut],([t],e)=>{t?Rt.volumes_data.get(t.volume_uuid).then(r=>{r&&e(r)}):e(void 0)});class V{constructor(e={}){$(this,"progress");$(this,"chars");$(this,"completed");$(this,"timeReadInMinutes");$(this,"settings");$(this,"lastProgressUpdate");var o,i,s;const r=JSON.parse(localStorage.getItem("settings")||"{}").volumeDefaults??{singlePageView:!1,rightToLeft:!0,hasCover:!1};this.progress=typeof e.progress=="number"?e.progress:0,this.chars=typeof e.chars=="number"?e.chars:0,this.completed=!!e.completed,this.timeReadInMinutes=typeof e.timeReadInMinutes=="number"?e.timeReadInMinutes:0,this.lastProgressUpdate=e.lastProgressUpdate||new Date(this.progress).toISOString(),this.settings={singlePageView:typeof((o=e.settings)==null?void 0:o.singlePageView)=="boolean"?e.settings.singlePageView:r.singlePageView,rightToLeft:typeof((i=e.settings)==null?void 0:i.rightToLeft)=="boolean"?e.settings.rightToLeft:r.rightToLeft,hasCover:typeof((s=e.settings)==null?void 0:s.hasCover)=="boolean"?e.settings.hasCover:r.hasCover}}static fromJSON(e){if(typeof e=="string")try{e=JSON.parse(e)}catch{e={}}return new V(e||{})}toJSON(){return{progress:this.progress,chars:this.chars,completed:this.completed,timeReadInMinutes:this.timeReadInMinutes,lastProgressUpdate:this.lastProgressUpdate,settings:{...this.settings}}}}function Yn(t){try{const e=JSON.parse(t);return Object.fromEntries(Object.entries(e).map(([r,o])=>[r,V.fromJSON(o)]))}catch{return{}}}const Jn=Yn(window.localStorage.getItem("volumes")||"{}"),B=fe(Jn);function so(t){B.update(e=>({...e,[t]:new V}))}function uo(t){B.update(e=>(delete e[t],e))}function lo(){B.set({})}function co(t,e,r,o=!1){B.update(i=>{const s=i[t]||new V;return{...i,[t]:new V({...s,progress:e,chars:r??s.chars,completed:o,lastProgressUpdate:new Date().toISOString()})}})}function fo(t){return setInterval(()=>{B.update(e=>{const r=e[t]||new V;return{...e,[t]:new V({...r,timeReadInMinutes:r.timeReadInMinutes+1})}})},60*1e3)}B.subscribe(t=>{{const e=t?Object.fromEntries(Object.entries(t).map(([r,o])=>[r,o.toJSON()])):{};window.localStorage.setItem("volumes",JSON.stringify(e))}});const mo=q(B,t=>{const e={};return t&&Object.keys(t).forEach(r=>{e[r]=t[r].progress}),e}),go=q(B,t=>{const e={};return t&&Object.keys(t).forEach(r=>{e[r]=t[r].settings}),e});function vo(t,e,r){B.update(o=>{const i=o[t]||new V;return{...o,[t]:new V({...i,settings:{...i.settings,[e]:r}})}}),Ln()}const ho=q([B,Le],([t,e])=>{if(e&&t)return Object.values(t).reduce((r,{chars:o,completed:i,timeReadInMinutes:s,progress:a})=>(i&&r.completed++,r.pagesRead+=a,r.minutesRead+=s,r.charsRead+=o,r),{charsRead:0,completed:0,pagesRead:0,minutesRead:0})}),po=q([jn,B],([t,e])=>{if(t&&e)return t.map(r=>r.volume_uuid).reduce((r,o)=>{var d,m,h;const i=((d=e[o])==null?void 0:d.timeReadInMinutes)||0,s=((m=e[o])==null?void 0:m.chars)||0,a=((h=e[o])==null?void 0:h.completed)||0;return r.timeReadInMinutes=r.timeReadInMinutes+i,r.chars=r.chars+s,r.completed=r.completed+a,r},{timeReadInMinutes:0,chars:0,completed:0})}),yo=q([Ut,B],([t,e])=>{if(t&&e){const{chars:r,completed:o,timeReadInMinutes:i,progress:s,lastProgressUpdate:a}=e[t.volume_uuid];return{chars:r,completed:o,timeReadInMinutes:i,progress:s,lastProgressUpdate:a}}return{chars:0,completed:0,timeReadInMinutes:0,progress:0,lastProgressUpdate:new Date(0).toISOString()}}),Ze={defaultFullscreen:!1,displayOCR:!0,textEditable:!1,textBoxBorders:!1,boldFont:!1,pageNum:!0,charCount:!1,mobile:!1,bounds:!1,backgroundColor:"#030712",swipeThreshold:50,edgeButtonWidth:40,showTimer:!1,quickActions:!0,fontSize:"auto",zoomDefault:"zoomFitToScreen",invertColors:!1,volumeDefaults:{singlePageView:!1,rightToLeft:!0,hasCover:!1},ankiConnectSettings:{enabled:!1,cropImage:!1,grabSentence:!1,overwriteImage:!0,pictureField:"Picture",sentenceField:"Sentence",triggerMethod:"both"}},Un={Default:Ze},It=window.localStorage.getItem("profiles"),Hn=It&&Wr?JSON.parse(It):Un,W=fe(Hn),Kn=window.localStorage.getItem("currentProfile")||"Default",O=fe(Kn);W.subscribe(t=>{window.localStorage.setItem("profiles",JSON.stringify(t))});O.subscribe(t=>{window.localStorage.setItem("currentProfile",t)});const Ht=q([W,O],([t,e])=>t[e]);function bo(t,e){W.update(r=>({...r,[P(O)]:{...r[P(O)],[t]:e}}))}function wo(t,e){W.update(r=>({...r,[P(O)]:{...r[P(O)],volumeDefaults:{...r[P(O)].volumeDefaults,[t]:e}}}))}function xo(t,e){W.update(r=>({...r,[P(O)]:{...r[P(O)],ankiConnectSettings:{...r[P(O)].ankiConnectSettings,[t]:e}}}))}function ko(){W.update(t=>({...t,[P(O)]:Ze}))}function So(t){W.update(e=>({...e,[t]:Ze}))}function To(t){P(O)===t&&O.set("Default"),W.update(e=>(delete e[t],e))}function Co(t,e){P(O)===t&&O.set("Default"),W.update(r=>(delete Object.assign(r,{[e]:r[t]})[t],r))}function Mo(t,e){W.update(r=>({...r,[e]:{...r[t]}}))}function Eo(t){O.set(t)}const Gn={galleryLayout:"grid",gallerySorting:"SMART"},At=window.localStorage.getItem("miscSettings"),Kt=fe(At?JSON.parse(At):Gn);Kt.subscribe(t=>{window.localStorage.setItem("miscSettings",JSON.stringify(t))});function _o(t,e){Kt.update(r=>({...r,[t]:e}))}export{To as A,no as B,Co as C,So as D,O as E,Eo as F,lo as G,ho as H,wo as I,vo as J,ko as K,Yn as L,B as a,po as b,Wn as c,uo as d,Rn as e,Pn as f,jn as g,io as h,oo as i,Ut as j,co as k,yo as l,Kt as m,fo as n,so as o,mo as p,go as q,xo as r,Ht as s,ao as t,_o as u,Jt as v,bo as w,W as x,Mo as y,Ln as z};
