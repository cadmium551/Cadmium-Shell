import fs from 'fs';

let content = fs.readFileSync('src/App.tsx', 'utf8');

content = content.replace(/rounded-3xl/g, 'rounded-sm');
content = content.replace(/rounded-2xl/g, 'rounded-sm');
content = content.replace(/rounded-xl/g, 'rounded-sm');
content = content.replace(/rounded-lg/g, 'rounded-sm');
content = content.replace(/rounded-\[3rem\]/g, 'rounded-sm');
content = content.replace(/rounded-\[2rem\]/g, 'rounded-sm');
content = content.replace(/duration-500/g, 'duration-200');
content = content.replace(/duration-300/g, 'duration-200');
content = content.replace(/shadow-2xl/g, 'shadow-md');
content = content.replace(/shadow-xl/g, 'shadow-md');
content = content.replace(/group-hover:rotate-6/g, '');
content = content.replace(/bg-\[#050505\]/g, 'bg-[#111111]');
content = content.replace(/LAUNCH ENGINE/g, 'LAUNCH');
content = content.replace(/Kill Process/g, 'Quit');

fs.writeFileSync('src/App.tsx', content);
