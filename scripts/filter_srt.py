import re, sys
src, dst = sys.argv[1], sys.argv[2]
with open(src) as f: content = f.read()
blocks = content.strip().split('\n\n')
out = []
i = 1
for block in blocks:
    lines = block.strip().split('\n')
    if len(lines) < 3: continue
    text_lines = lines[2:]
    filtered = []
    for line in text_lines:
        line = re.sub(r'[\(\[].*?[\)\]]', '', line)
        line = re.sub(r'^\s*-\s*', '', line)
        line = line.strip()
        if line:
            filtered.append(line)
    if filtered:
        out.append(str(i))
        out.append(lines[1])
        out.extend(filtered)
        out.append('')
        i += 1
with open(dst, 'w') as f: f.write('\n'.join(out))
