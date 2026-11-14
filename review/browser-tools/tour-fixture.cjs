/* Existing synthetic suites exercise the app after dismissing the new guide.
   The dedicated tour suite intentionally receives no automatic dismissal. */
if(!process.argv[1]?.endsWith('tour-0239.cjs')&&!process.argv[1]?.endsWith('tour-0252.cjs')&&!process.argv[1]?.endsWith('petak-0257.cjs')){
 const pw=require('playwright'),launch=pw.chromium.launch.bind(pw.chromium);
 const dismiss=()=>{
  const skip=()=>{const el=document.querySelector('#feature-tour:not(.hidden) #tour-skip');if(el)el.click();};
  new MutationObserver(skip).observe(document,{subtree:true,childList:true,attributes:true,attributeFilter:['class']});
 };
 pw.chromium.launch=async(...args)=>{
  const browser=await launch(...args),context=browser.newContext.bind(browser),page=browser.newPage.bind(browser);
  browser.newContext=async(...a)=>{const c=await context(...a);await c.addInitScript(dismiss);return c;};
  browser.newPage=async(...a)=>{const p=await page(...a);await p.addInitScript(dismiss);return p;};
  return browser;
 };
}
