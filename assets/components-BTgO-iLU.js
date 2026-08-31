import{j as o}from"./vendor-react-DJbYE_OA.js";import{z as d}from"./index--LP-nB9l.js";function f(t){const[n,e]=t.split("-").map(Number);return!n||!e?t:new Date(n,e-1,1).toLocaleDateString("en-GB",{month:"long",year:"numeric"})}function h(t){return t.toFixed(2)}function y(t){return new Map(t.map(n=>[n.id,n]))}function g(t,n,e){const[s,a]=e.split("-").map(Number),r=new Date(s,a-1,1),i=new Date(s,a,0),p=new Date(`${t}T00:00:00`),c=new Date(`${n}T00:00:00`),m=p>r?p:r,l=c<i?c:i;return l<m?0:Math.round((l.getTime()-m.getTime())/864e5)+1}function b({areaClass:t}){return o.jsx("style",{"code-path":"src/pages/payroll/components.tsx:14:5",children:`
@media print {
  body * { visibility: hidden; }
  .${t}, .${t} * { visibility: visible; }
  .${t} {
    position: absolute;
    inset: 0 auto auto 0;
    width: 100%;
    margin: 0 !important;
    padding: 0 !important;
    border: none !important;
    box-shadow: none !important;
    background: #ffffff !important;
    color: #1c1917 !important;
  }
  .${t} .print-text-muted { color: #57534e !important; }
  @page { margin: 12mm; }
}
`})}function w({children:t,className:n}){return o.jsx("span",{"code-path":"src/pages/payroll/components.tsx:38:10",className:d("tabular-nums",n),children:t})}function j({title:t,subtitle:n,action:e}){return o.jsxs("div",{"code-path":"src/pages/payroll/components.tsx:52:5",className:"flex flex-wrap items-start justify-between gap-3",children:[o.jsxs("div",{"code-path":"src/pages/payroll/components.tsx:53:7",className:"space-y-1",children:[o.jsx("h3",{"code-path":"src/pages/payroll/components.tsx:54:9",className:"text-base font-semibold",children:t}),o.jsx("p",{"code-path":"src/pages/payroll/components.tsx:55:9",className:"text-xs text-muted-foreground",children:n})]}),e]})}export{j as F,w as M,b as P,y as e,f as m,h as n,g as o};
