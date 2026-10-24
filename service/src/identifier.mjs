import { Problem } from './config.mjs'
export const defaultValidation={minLength:14,maxLength:14,pattern:'^[0-9]{14}$'}
export function validationRules(value=defaultValidation){
    const {minLength,maxLength,pattern=''}=value||{}
    if(!Number.isInteger(minLength)||!Number.isInteger(maxLength)||minLength<1||maxLength<minLength||maxLength>128||typeof pattern!=='string'||pattern.length>150)
        throw new Problem(400,'VALIDATION_RULES','Identifier length must be between 1 and 128 characters.')
    // One character class with optional literal prefix/suffix. No groups,
    // alternation, backreferences or nested repetition: bounded, predictable work.
    if(pattern&&!/^\^?[A-Za-z0-9 _.\-]*\[[A-Za-z0-9 \-_]+\](?:[+*?]|\{[0-9]{1,3}(?:,[0-9]{0,3})?\})?[A-Za-z0-9 _.\-]*\$?$/.test(pattern))
        throw new Problem(400,'VALIDATION_PATTERN','Use one character class, optionally with a literal prefix/suffix and repetition, for example ^[0-9]{14}$ or ^PAT-[A-Z0-9]+$.')
    try{if(pattern)new RegExp(`^(?:${pattern})$`)}catch{throw new Problem(400,'VALIDATION_PATTERN','Invalid identifier pattern.')}
    return {minLength,maxLength,pattern}
}
export function validIdentifier(value,config){
    const r=config.identifierValidation||defaultValidation
    return typeof value==='string'&&value.length>=r.minLength&&value.length<=r.maxLength&&!!value.trim()&&
        !/[\u0000-\u001f\u007f]/.test(value)&&(!r.pattern||new RegExp(`^(?:${r.pattern})$`).test(value))
}
export const filterValue=value=>String(value).replace(/\//g,'//').replace(/[:,]/g,x=>'/'+x)
export function maskIdentifier(value){const visible=Math.min(4,Math.floor(value.length/2));return '*'.repeat(Math.max(4,value.length-visible))+(visible?value.slice(-visible):'')}
