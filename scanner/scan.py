import json,urllib.request,sys,os,time
COINS=["NEARUSDT","INJUSDT","RENDERUSDT","FETUSDT","ARBUSDT"]
TF="15m"; N=14
STATE="/workspace/adx/state.json"
def tf_ms(tf):
    n=int(tf[:-1]); u=tf[-1]
    return n*{"m":60000,"h":3600000,"d":86400000}[u]
INT=tf_ms(TF)
def kl(s):
    err=None
    req=urllib.request.Request(
        f"https://fapi.binance.com/fapi/v1/klines?symbol={s}&interval={TF}&limit=300",
        headers={"User-Agent":"Mozilla/5.0"}
    )
    for attempt in range(8):
        try:
            return json.load(urllib.request.urlopen(req,timeout=15))
        except Exception as e:
            err=e; time.sleep(1.5)
    raise err
def wilder(x,n):
    out=[None]*len(x); s=sum(x[1:n+1]); out[n]=s
    for i in range(n+1,len(x)): s=s-s/n+x[i]; out[i]=s
    return out
def adx(k):
    k=k[:-1]  # closed candles only
    h=[float(c[2]) for c in k]; l=[float(c[3]) for c in k]; c_=[float(c[4]) for c in k]
    tr=[0];pdm=[0];mdm=[0]
    for i in range(1,len(k)):
        tr.append(max(h[i]-l[i],abs(h[i]-c_[i-1]),abs(l[i]-c_[i-1])))
        up=h[i]-h[i-1]; dn=l[i-1]-l[i]
        pdm.append(up if up>dn and up>0 else 0); mdm.append(dn if dn>up and dn>0 else 0)
    a,p,m=wilder(tr,N),wilder(pdm,N),wilder(mdm,N)
    pdi=[None]*len(k);mdi=[None]*len(k);dx=[None]*len(k)
    for i in range(N,len(k)):
        pdi[i]=100*p[i]/a[i]; mdi[i]=100*m[i]/a[i]
        dx[i]=100*abs(pdi[i]-mdi[i])/(pdi[i]+mdi[i]) if pdi[i]+mdi[i] else 0
    ad=[None]*len(k); ad[2*N-1]=sum(dx[N:2*N])/N
    for i in range(2*N,len(k)): ad[i]=(ad[i-1]*(N-1)+dx[i])/N
    return k,c_[-1],pdi,mdi,ad
st=json.load(open(STATE)) if os.path.exists(STATE) else {}
res=[]
for s in COINS:
    try: ks,price,pdi,mdi,ad=adx(kl(s))
    except Exception as e: res.append({"symbol":s,"error":str(e)}); continue
    sig=None; i=len(ad)-1
    for j in range(len(ad)-5,len(ad)):
        if ad[j]>=25 and ad[j]>ad[j-1]:
            if pdi[j]>mdi[j] and (pdi[j-1]<=mdi[j-1] or ad[j-1]<25): sig="LONG"; i=j
            if mdi[j]>pdi[j] and (mdi[j-1]<=pdi[j-1] or ad[j-1]<25): sig="SHORT"; i=j
    t_sig=int(ks[i][6])
    key=f"{s}:{t_sig}"
    new = sig and st.get(s)!=key
    if new: st[s]=key
    res.append({"symbol":s,"close":price,"adx":round(ad[i],1),"adx_prev":round(ad[i-1],1),"+di":round(pdi[i],1),"-di":round(mdi[i],1),"signal":sig,"new_alert":bool(new),"candle_close_utc":time.strftime('%Y-%m-%d %H:%M',time.gmtime((t_sig+1)/1000))})
json.dump(st,open(STATE,"w"))
print(json.dumps(res,indent=1))
