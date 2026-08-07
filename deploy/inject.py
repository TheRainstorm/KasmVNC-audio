import re

js = open("/tmp/player-v4.js", encoding="utf-8").read()
for f in ["/usr/share/kasmvnc/www/index.html", "/usr/share/kasmvnc/www/vnc.html"]:
    h = open(f, encoding="utf-8").read()
    h = re.sub(r'<script id="kasmAudioPlayer">.*?</script>\s*', "", h, flags=re.S)
    tag = '<script id="kasmAudioPlayer">\n' + js + "\n</script>\n"
    if "</body>" in h:
        h = h.replace("</body>", tag + "</body>", 1)
    else:
        h += tag
    open(f, "w", encoding="utf-8").write(h)
    print(f, "injected bytes:", len(tag))
