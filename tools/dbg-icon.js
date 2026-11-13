// 调试: 追踪某个 exe 的图标提取卡在哪一步
const fs = require('fs');
const { PeFile, decodeDIB } = require('../src/peicon');

const files = process.argv.slice(2);
for (const f of files) {
  console.log('\n=== ' + f);
  if (!fs.existsSync(f)) { console.log('  文件不存在'); continue; }
  const pe = new PeFile(f);
  try {
    const ok = pe.parseHeaders();
    console.log(`  头部解析: ${ok}, size=${(pe.size / 1024).toFixed(0)}KB, sections=${pe.sections.length}`);
    if (!ok) continue;
    console.log(`  resBase=${pe.resBase} resSize=${pe.resSize} tree=${pe.tree.length}`);
    const types = pe.listDir(0);
    console.log('  资源类型:', types.map((t) => `${t.id}${t.named ? '(n)' : ''}${t.isDir ? '' : '(leaf)'}`).join(', '));
    const groups = pe.idsOf(14);
    console.log('  RT_GROUP_ICON ids:', groups.join(',') || '(无)');
    for (const gid of groups.slice(0, 3)) {
      const g = pe.findResource(14, gid);
      if (!g) { console.log(`   group ${gid}: 读取失败`); continue; }
      const count = g.readUInt16LE(4);
      console.log(`   group ${gid}: count=${count} bytes=${g.length}`);
      for (let i = 0; i < count; i++) {
        const e = 6 + i * 14;
        if (e + 14 > g.length) break;
        const id = g.readUInt16LE(e + 12);
        const data = pe.findResource(3, id);
        const isPng = data && data.length > 8 && data.readUInt32BE(0) === 0x89504e47;
        const dib = !isPng && data ? decodeDIB(data) : null;
        console.log(`     #${i} ${g[e] === 0 ? 256 : g[e]}x${g[e + 1] === 0 ? 256 : g[e + 1]} bpp=${g.readUInt16LE(e + 6)} id=${id} -> data=${data ? data.length + 'B' : 'null'} ${isPng ? 'PNG' : dib ? `DIB ${dib.width}x${dib.height}` : '解码失败'}`);
      }
    }
  } finally {
    pe.close();
  }
}
