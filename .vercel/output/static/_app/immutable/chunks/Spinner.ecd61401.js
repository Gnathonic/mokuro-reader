import{s as B,y as d,M as g,N as m,h,d as c,j as f,O as _,i as E,A as b,L as F,G as z,H as k}from"./scheduler.d583122a.js";import{t as w,g as Z}from"./db.1a03e27e.js";import{S as x,i as j}from"./index.6f9a916b.js";function q(s){let l,t,o,n,a=[s[5],{role:"status"},{class:n=w("inline -mt-px animate-spin dark:text-gray-600",s[3],s[0],s[4],s[6].class)},{viewBox:"0 0 100 101"},{fill:"none"},{xmlns:"http://www.w3.org/2000/svg"}],u={};for(let e=0;e<a.length;e+=1)u=d(u,a[e]);return{c(){l=g("svg"),t=g("path"),o=g("path"),this.h()},l(e){l=m(e,"svg",{role:!0,class:!0,viewBox:!0,fill:!0,xmlns:!0});var r=h(l);t=m(r,"path",{d:!0,fill:!0}),h(t).forEach(c),o=m(r,"path",{d:!0,fill:!0}),h(o).forEach(c),r.forEach(c),this.h()},h(){f(t,"d","M100 50.5908C100 78.2051 77.6142 100.591 50 100.591C22.3858 100.591 0 78.2051 0 50.5908C0 22.9766 22.3858 0.59082 50 0.59082C77.6142 0.59082 100 22.9766 100 50.5908ZM9.08144 50.5908C9.08144 73.1895 27.4013 91.5094 50 91.5094C72.5987 91.5094 90.9186 73.1895 90.9186 50.5908C90.9186 27.9921 72.5987 9.67226 50 9.67226C27.4013 9.67226 9.08144 27.9921 9.08144 50.5908Z"),f(t,"fill",s[2]),f(o,"d","M93.9676 39.0409C96.393 38.4038 97.8624 35.9116 97.0079 33.5539C95.2932 28.8227 92.871 24.3692 89.8167 20.348C85.8452 15.1192 80.8826 10.7238 75.2124 7.41289C69.5422 4.10194 63.2754 1.94025 56.7698 1.05124C51.7666 0.367541 46.6976 0.446843 41.7345 1.27873C39.2613 1.69328 37.813 4.19778 38.4501 6.62326C39.0873 9.04874 41.5694 10.4717 44.0505 10.1071C47.8511 9.54855 51.7191 9.52689 55.5402 10.0491C60.8642 10.7766 65.9928 12.5457 70.6331 15.2552C75.2735 17.9648 79.3347 21.5619 82.5849 25.841C84.9175 28.9121 86.7997 32.2913 88.1811 35.8758C89.083 38.2158 91.5421 39.6781 93.9676 39.0409Z"),f(o,"fill",s[1]),_(l,u)},m(e,r){E(e,l,r),b(l,t),b(l,o)},p(e,[r]){r&4&&f(t,"fill",e[2]),r&2&&f(o,"fill",e[1]),_(l,u=Z(a,[r&32&&e[5],{role:"status"},r&65&&n!==(n=w("inline -mt-px animate-spin dark:text-gray-600",e[3],e[0],e[4],e[6].class))&&{class:n},{viewBox:"0 0 100 101"},{fill:"none"},{xmlns:"http://www.w3.org/2000/svg"}]))},i:F,o:F,d(e){e&&c(l)}}}function A(s,l,t){const o=["color","bg","customColor","size","currentFill","currentColor"];let n=z(l,o),{color:a="primary"}=l,{bg:u="text-gray-300"}=l,{customColor:e=""}=l,{size:r="8"}=l,{currentFill:C="currentFill"}=l,{currentColor:v="currentColor"}=l,M=`w-${r} h-${r}`;C!=="currentFill"&&(a=void 0);const y={primary:"fill-primary-600",blue:"fill-blue-600",gray:"fill-gray-600 dark:fill-gray-300",green:"fill-green-500",red:"fill-red-600",yellow:"fill-yellow-400",pink:"fill-pink-600",purple:"fill-purple-600",white:"fill-white",custom:e};let S=a===void 0?"":y[a]??y.blue;return s.$$set=i=>{t(6,l=d(d({},l),k(i))),t(5,n=z(l,o)),"color"in i&&t(7,a=i.color),"bg"in i&&t(0,u=i.bg),"customColor"in i&&t(8,e=i.customColor),"size"in i&&t(9,r=i.size),"currentFill"in i&&t(1,C=i.currentFill),"currentColor"in i&&t(2,v=i.currentColor)},l=k(l),[u,C,v,M,S,n,l,a,e,r]}class N extends x{constructor(l){super(),j(this,l,A,q,B,{color:7,bg:0,customColor:8,size:9,currentFill:1,currentColor:2})}}export{N as S};
