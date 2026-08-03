import sys

filepath = sys.argv[1]
with open(filepath, 'r') as f:
    content = f.read()

old = '''      </section>\n\n      {/* Recently Viewed */}\n      {recentNovels.length > 0 && ('''
new = '''      </section>\n\n      {/* Continue Reading */}\n      <section className="border-b">\n        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-5">\n          <ContinueReading />\n        </div>\n      </section>\n\n      {/* Recently Viewed */}\n      {recentNovels.length > 0 && ('''

content = content.replace(old, new, 1)

# Also add the import
old_import = '''import { BackToTop } from '@/components/BackToTop';'''
new_import = '''import { BackToTop } from '@/components/BackToTop';\nimport { ContinueReading } from '@/components/home/ContinueReading';'''
content = content.replace(old_import, new_import, 1)

with open(filepath, 'w') as f:
    f.write(content)
print('done')
