# Extracts the 100STYLE "Neutral" BVH takes (CC BY 4.0, https://zenodo.org/records/8127870) into argv[1] without
# downloading the whole 1.4 GB zip: zipfile over HTTP range requests.
import io, os, sys, urllib.request, zipfile

URL = "https://zenodo.org/records/8127870/files/100STYLE.zip?download=1"


class Remote(io.RawIOBase):
    def __init__(self):
        self.pos = 0
        self.size = int(urllib.request.urlopen(urllib.request.Request(URL, method="HEAD")).headers["Content-Length"])

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos

    def readinto(self, b):
        if not len(b) or self.pos >= self.size:
            return 0
        end = min(self.size, self.pos + len(b)) - 1
        data = urllib.request.urlopen(urllib.request.Request(URL, headers={"Range": f"bytes={self.pos}-{end}"})).read()
        b[: len(data)] = data
        self.pos += len(data)
        return len(data)


z = zipfile.ZipFile(io.BufferedReader(Remote(), buffer_size=1 << 20))
for name in z.namelist():
    if name.startswith("100STYLE/Neutral/Neutral_") and name.endswith(".bvh"):
        open(os.path.join(sys.argv[1], os.path.basename(name)), "wb").write(z.read(name))
        print(name)
