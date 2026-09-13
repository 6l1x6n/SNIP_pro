"""add_dark_classes.py — добавляет dark: варианты классов в файлы без тёмной темы.
Осторожно: не трогает уже существующие dark:, hover:/focus:/md: префиксы."""
import re, sys

MAPPINGS = [
    (r'(?<![:\w-])bg-white\b', 'dark:bg-slate-900'),
    (r'(?<![:\w-])bg-slate-50\b', 'dark:bg-slate-800/60'),
    (r'(?<![:\w-])bg-slate-100\b', 'dark:bg-slate-800'),
    (r'border-slate-200\b(?!.*dark:border)', 'dark:border-slate-700'),
    (r'(?<!dark:)border-slate-200\b', 'dark:border-slate-700'),
    (r'(?<!dark:)border-slate-100\b', 'dark:border-slate-800'),
    (r'(?<!dark:)border-slate-300\b', 'dark:border-slate-600'),
    (r'(?<!dark:)text-slate-900\b', 'dark:text-white'),
    (r'(?<!dark:)text-slate-800\b', 'dark:text-slate-100'),
    (r'(?<!dark:)text-slate-700\b', 'dark:text-slate-200'),
    (r'(?<!dark:)text-slate-600\b', 'dark:text-slate-300'),
    (r'(?<!dark:)text-slate-500\b', 'dark:text-slate-400'),
    (r'(?<!dark:)divide-slate-100\b', 'dark:divide-slate-800'),
    (r'hover:bg-slate-50\b(?!.*dark:hover)', 'dark:hover:bg-slate-800'),
]

def process(path):
    src = open(path, encoding='utf-8').read()
    out = src
    for pat, add in MAPPINGS:
        # добавляем dark-класс сразу после совпадения, если его ещё нет в этом className
        def repl(m):
            return m.group(0) + ' ' + add
        # пропускаем строки, где этот dark-класс уже есть рядом
        lines = out.split('\n')
        new_lines = []
        for line in lines:
            if re.search(pat, line) and add not in line:
                line = re.sub(pat, repl, line)
            new_lines.append(line)
        out = '\n'.join(new_lines)
    if out != src:
        open(path, 'w', encoding='utf-8').write(out)
        print(f"  ✓ {path}")
    else:
        print(f"  - {path} (без изменений)")

for p in sys.argv[1:]:
    process(p)
