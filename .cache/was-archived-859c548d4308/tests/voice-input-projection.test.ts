import { test } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readApps } from '../server/wizard-os-settings.mjs';
test('trusted catalog projects only strict voice booleans; installed entry wins', () => {
  const dir=mkdtempSync(join(tmpdir(),'voice-projection-'));
  try {
    const appsJsonPath=join(dir,'apps.json'),launcherPath=join(dir,'launcher.json');
    writeFileSync(appsJsonPath,JSON.stringify({apps:[{id:'editor',view:'/editor/',receives_voice_input:true},{id:'disabled',view:'/disabled/',receives_voice_input:false},{id:'no-view',receives_voice_input:true}]}));
    writeFileSync(launcherPath,JSON.stringify({links:[{id:'disabled',url:'/override/',receives_voice_input:true},{id:'search',url:'/search/',receives_voice_input:true},{id:'string',url:'/string/',receives_voice_input:'true'},{id:'absent',url:'/absent/'}]}));
    const apps=Object.fromEntries(readApps({appsJsonPath,launcherPath}).apps.map(a=>[a.id,a]));
    assert.equal(apps.editor.receives_voice_input,true);assert.equal(apps.search.receives_voice_input,true);
    for(const id of ['disabled','no-view','string','absent'])assert.equal(apps[id].receives_voice_input,false,id);
    assert.equal(apps.disabled.url,'/disabled/');
  } finally {rmSync(dir,{recursive:true,force:true});}
});
