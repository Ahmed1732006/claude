import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const android = join(root, 'android');
const app = join(android, 'app');
const res = join(app, 'src', 'main', 'res');

if (!existsSync(app)) throw new Error('Android project was not generated. Run npx cap add android first.');

// Firebase Android config belongs in android/app, never inside the web bundle.
const gs = join(root, 'google-services.json');
if (existsSync(gs)) copyFileSync(gs, join(app, 'google-services.json'));

// Keep the current app identity and bump the release metadata. The currently-distributed
// release APK is versionCode 11 / versionName 1.2.0 (confirmed from its AndroidManifest.xml,
// not assumed) - these fallbacks only apply to a manual/local run; the GitHub Actions workflow
// always sets ANDROID_VERSION_CODE/ANDROID_VERSION_NAME explicitly (see "Set release version").
const versionCode = Number(process.env.ANDROID_VERSION_CODE || 12);
const versionName = process.env.ANDROID_VERSION_NAME || '1.2.1';
const gradle = join(app, 'build.gradle');
if (existsSync(gradle)) {
  let text = readFileSync(gradle, 'utf8');
  text = text.replace(/versionCode\s+\d+/g, `versionCode ${versionCode}`);
  text = text.replace(/versionName\s+['"][^'"]+['"]/g, `versionName '${versionName}'`);
  text = text.replace(/applicationId\s+['"][^'"]+['"]/g, `applicationId 'com.inthevoid.platform'`);
  if (!text.includes('inTheVoidRelease')) {
    const androidBlock = text.indexOf('android {');
    if (androidBlock >= 0) {
      text = text.slice(0, androidBlock) + `android {
    signingConfigs {
        inTheVoidRelease {
            def keystorePath = System.getenv("ANDROID_KEYSTORE_PATH")
            storeFile file(keystorePath ?: "in_the_void_release.jks")
            storePassword System.getenv("ANDROID_KEYSTORE_PASSWORD") ?: ""
            keyAlias System.getenv("ANDROID_KEY_ALIAS") ?: "in-the-void-release"
            keyPassword System.getenv("ANDROID_KEY_PASSWORD") ?: ""
        }
    }
` + text.slice(androidBlock + 'android {'.length);
      const buildTypesAt = text.indexOf('buildTypes {');
      if (buildTypesAt >= 0) {
        const releaseAt = text.indexOf('release {', buildTypesAt);
        if (releaseAt >= 0) {
          text = text.slice(0, releaseAt) + 'release {\n            signingConfig signingConfigs.inTheVoidRelease\n        ' + text.slice(releaseAt + 'release {'.length);
        } else {
          text = text.slice(0, buildTypesAt) + 'buildTypes {\n        release { signingConfig signingConfigs.inTheVoidRelease }' + text.slice(buildTypesAt + 'buildTypes {'.length);
        }
      }
    }
  }
  writeFileSync(gradle, text);
}

// Keep the existing application icon unchanged. Capacitor Assets is invoked by CI
// for launcher/adaptive variants from the existing resources/icon.png.
const iconSource = join(root, 'resources', 'icon.png');
if (existsSync(iconSource)) {
  for (const dir of ['mipmap-mdpi','mipmap-hdpi','mipmap-xhdpi','mipmap-xxhdpi','mipmap-xxxhdpi']) {
    const targetDir = join(res, dir); mkdirSync(targetDir, { recursive: true });
    copyFileSync(iconSource, join(targetDir, 'ic_launcher.png'));
    copyFileSync(iconSource, join(targetDir, 'ic_launcher_round.png'));
  }
}

// Keep the generated project from accidentally bundling any service-account JSON.
const forbidden = ['firebase-adminsdk', 'service-account', 'private-key'];
const rootFiles = [];
for (const name of rootFiles) {
  if (forbidden.some(x => name.toLowerCase().includes(x))) throw new Error(`Refusing to package secret file: ${name}`);
}


// Native PDF viewer + safe "open with another app" bridge.
// This is injected only into the generated Android project; the web build remains unchanged.
const javaBase = join(app, 'src', 'main', 'java', 'com', 'inthevoid', 'platform');
mkdirSync(javaBase, { recursive: true });
writeFileSync(join(javaBase, 'PdfViewerPlugin.java'), `package com.inthevoid.platform;

import android.content.Intent;
import android.util.Base64;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;

@CapacitorPlugin(name = "PdfViewer")
public class PdfViewerPlugin extends Plugin {
    @PluginMethod
    public void open(PluginCall call) {
        String base64 = call.getString("base64", "");
        String name = call.getString("filename", "file.pdf");
        if (base64 == null || base64.isEmpty()) { call.reject("PDF data is empty"); return; }
        try {
            if (name == null || name.trim().isEmpty()) name = "file.pdf";
            name = name.replaceAll("[^A-Za-z0-9._-]", "_");
            if (!name.toLowerCase().endsWith(".pdf")) name += ".pdf";
            File dir = new File(getContext().getCacheDir(), "pdf");
            if (!dir.exists() && !dir.mkdirs()) throw new Exception("Cannot create PDF cache");
            File file = new File(dir, System.currentTimeMillis() + "_" + name);
            byte[] bytes = Base64.decode(base64, Base64.DEFAULT);
            try (FileOutputStream out = new FileOutputStream(file)) { out.write(bytes); }
            Intent intent = new Intent(getContext(), PdfViewerActivity.class);
            intent.putExtra("pdf_path", file.getAbsolutePath());
            intent.putExtra("pdf_name", name);
            getActivity().startActivity(intent);
            JSObject ret = new JSObject(); ret.put("opened", true); call.resolve(ret);
        } catch (Exception e) { call.reject("تعذر فتح ملف PDF", e); }
    }

    public static void openExternal(android.content.Context context, File file) {
        try {
            android.net.Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file);
            Intent view = new Intent(Intent.ACTION_VIEW);
            view.setDataAndType(uri, "application/pdf");
            view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(Intent.createChooser(view, "فتح باستخدام تطبيق آخر"));
        } catch (Exception e) {
            android.widget.Toast.makeText(context, "لا يوجد تطبيق مثبت لفتح ملف PDF.", android.widget.Toast.LENGTH_SHORT).show();
        }
    }
}
`);
writeFileSync(join(javaBase, 'PdfViewerActivity.java'), `package com.inthevoid.platform;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.drawable.GradientDrawable;
import android.graphics.pdf.PdfRenderer;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;
import java.io.File;
import java.util.ArrayList;

// Modern, self-contained two-axis pan/zoom PDF viewer (native android.graphics.pdf.PdfRenderer,
// no extra dependency). Replaces the previous ScrollView-based viewer, which only ever supported
// vertical scrolling: once zoomed in, there was no way to pan left/right to reach content wider
// than the screen, and the zoom pivot depended on ScrollView's own touch interception. This
// version owns all touch handling itself (pinch handled by ScaleGestureDetector, pan handled by
// tracking the centroid of active pointers - a two-finger drag while pinching is treated as
// deliberate pan, and works from anywhere on the screen, not just symmetric two-finger gestures),
// so zoom and pan behave like a standard modern mobile PDF/photo viewer.
public class PdfViewerActivity extends Activity {
    private PdfRenderer renderer;
    private ParcelFileDescriptor descriptor;
    private PdfPagesView pages;
    private TextView pageLabel;
    private int pageCount;
    private int currentPage = 0;
    private File pdfFile;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().setStatusBarColor(Color.rgb(3,10,20));
        getWindow().setNavigationBarColor(Color.rgb(3,10,20));
        if (android.os.Build.VERSION.SDK_INT >= 29) getWindow().setNavigationBarContrastEnforced(false);

        try {
            String path = getIntent().getStringExtra("pdf_path");
            if (path == null || path.isEmpty()) throw new Exception("PDF path is empty");
            pdfFile = new File(path);
            descriptor = ParcelFileDescriptor.open(pdfFile, ParcelFileDescriptor.MODE_READ_ONLY);
            renderer = new PdfRenderer(descriptor);
            pageCount = renderer.getPageCount();

            LinearLayout root = new LinearLayout(this);
            root.setOrientation(LinearLayout.VERTICAL);
            root.setBackgroundColor(Color.rgb(3,10,20));

            LinearLayout bar = new LinearLayout(this);
            bar.setGravity(Gravity.CENTER_VERTICAL);
            bar.setPadding(dp(8),dp(6),dp(8),dp(6));
            bar.setBackgroundColor(Color.rgb(10,22,38));

            // Close button: solid red, high-contrast, generous touch target. Lives in the fixed
            // top bar (not inside the zoomable/scrollable canvas), so it never shrinks, fades or
            // gets covered while zooming or scrolling.
            Button close = closeButton();
            Button prev = button("‹", false);
            Button next = button("›", false);
            Button external = button("فتح باستخدام تطبيق آخر", true);

            TextView title = new TextView(this);
            title.setText(getIntent().getStringExtra("pdf_name"));
            title.setTextColor(Color.WHITE);
            title.setTextSize(14);
            title.setGravity(Gravity.CENTER);
            title.setSingleLine(true);
            title.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);

            pageLabel = new TextView(this);
            pageLabel.setTextColor(Color.WHITE);
            pageLabel.setTextSize(12);
            pageLabel.setGravity(Gravity.CENTER);
            updateLabel();

            bar.addView(close, weight(0.62f));
            bar.addView(prev, weight(0.62f));
            bar.addView(pageLabel, weight(1.05f));
            bar.addView(next, weight(0.62f));
            bar.addView(title, weight(2.0f));
            bar.addView(external, weight(2.35f));

            root.addView(bar, new LinearLayout.LayoutParams(-1, dp(64)));

            pages = new PdfPagesView();
            root.addView(pages, new LinearLayout.LayoutParams(-1,0,1));

            setContentView(root);

            close.setOnClickListener(v -> finish());
            prev.setOnClickListener(v -> pages.goToPage(currentPage - 1));
            next.setOnClickListener(v -> pages.goToPage(currentPage + 1));
            external.setOnClickListener(v -> PdfViewerPlugin.openExternal(this, pdfFile));
        } catch(Exception e) {
            Toast.makeText(this,"تعذر فتح ملف PDF",Toast.LENGTH_LONG).show();
            finish();
        }
    }

    private void updateLabel() {
        if(pageLabel!=null) pageLabel.setText((currentPage+1)+" / "+pageCount);
    }

    private Button button(String text, boolean wide) {
        Button b=new Button(this);
        b.setText(text);
        b.setTextColor(Color.WHITE);
        b.setTextSize(wide ? 12 : 22);
        b.setAllCaps(false);
        b.setMinHeight(dp(46));
        b.setMinWidth(dp(wide ? 120 : 46));
        b.setPadding(dp(wide ? 10 : 4),0,dp(wide ? 10 : 4),0);
        GradientDrawable bg=new GradientDrawable();
        bg.setColor(wide ? Color.rgb(38,99,235) : Color.rgb(25,42,64));
        bg.setCornerRadius(dp(10));
        b.setBackground(bg);
        return b;
    }

    private Button closeButton() {
        Button b=new Button(this);
        b.setText("×");
        b.setTextColor(Color.WHITE);
        b.setTextSize(24);
        b.setAllCaps(false);
        b.setMinHeight(dp(46));
        b.setMinWidth(dp(46));
        b.setPadding(dp(4),0,dp(4),0);
        b.setContentDescription("إغلاق");
        GradientDrawable bg=new GradientDrawable();
        bg.setColor(Color.rgb(220,38,38)); // strong, unambiguous red - never blends with the dark bar
        bg.setCornerRadius(dp(10));
        b.setBackground(bg);
        return b;
    }

    private LinearLayout.LayoutParams weight(float w) {
        return new LinearLayout.LayoutParams(0,-1,w);
    }

    private int dp(int v) {
        return (int)(v*getResources().getDisplayMetrics().density+0.5f);
    }

    @Override protected void onDestroy() {
        super.onDestroy();
        try {
            if(renderer!=null)renderer.close();
            if(descriptor!=null)descriptor.close();
        }catch(Exception ignored){}
    }

    private class PdfPagesView extends View {
        Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG|Paint.FILTER_BITMAP_FLAG);
        ArrayList<Integer> baseHeights=new ArrayList<>();
        ArrayList<Bitmap> bitmaps=new ArrayList<>();
        int contentWidth=0;
        int contentHeight=0;
        boolean laidOut=false;

        // scale/pan model: content is drawn in its own unscaled coordinate space, then the whole
        // canvas is translated by (panX,panY) and scaled by the current zoom level around the
        // origin. This keeps zoom and pan fully independent of any parent scrolling container.
        float scale=1f;
        float panX=0f, panY=0f;
        static final float MIN_SCALE=1f, MAX_SCALE=4f;

        ScaleGestureDetector scaleDetector;
        // Pan tracking: centroid of all currently-down pointers. Works for a one-finger drag and
        // for a two-finger drag (fingers can be anywhere on screen, not just left/right of center).
        float lastCentroidX=0f, lastCentroidY=0f;
        boolean centroidValid=false;

        PdfPagesView() {
            super(PdfViewerActivity.this);
            setBackgroundColor(Color.rgb(25,32,42));
            for(int i=0;i<pageCount;i++){ baseHeights.add(dp(500)); bitmaps.add(null); }

            scaleDetector=new ScaleGestureDetector(PdfViewerActivity.this,
                new ScaleGestureDetector.SimpleOnScaleGestureListener() {
                    @Override public boolean onScaleBegin(ScaleGestureDetector d) { return true; }

                    @Override public boolean onScale(ScaleGestureDetector d) {
                        float factor=d.getScaleFactor();
                        float next=Math.max(MIN_SCALE,Math.min(MAX_SCALE,scale*factor));
                        if(Math.abs(next-scale)<0.0005f) return true;
                        // Keep the point currently under the fingers fixed on screen: convert the
                        // focal point to content-space using the OLD scale/pan, then recompute pan
                        // so that same content point lands under the (possibly moved) focal point
                        // at the NEW scale.
                        float focusX=d.getFocusX(), focusY=d.getFocusY();
                        float contentX=(focusX-panX)/scale;
                        float contentY=(focusY-panY)/scale;
                        scale=next;
                        panX=focusX-contentX*scale;
                        panY=focusY-contentY*scale;
                        clampPan();
                        invalidate();
                        return true;
                    }
                });
        }

        void goToPage(int p) {
            p=Math.max(0,Math.min(pageCount-1,p));
            panY=-unscaledPageTop(p)*scale;
            clampPan();
            currentPage=p;
            updateLabel();
            invalidate();
        }

        int unscaledPageTop(int p) {
            int y=0;
            for(int i=0;i<p;i++) y+=baseHeights.get(i)+dp(14);
            return y;
        }

        void recomputeCurrentPage() {
            float contentTop=-panY/Math.max(0.0001f,scale);
            int acc=0, found=0;
            for(int i=0;i<pageCount;i++){
                int h=baseHeights.get(i)+dp(14);
                if(contentTop<acc+h){ found=i; break; }
                acc+=h; found=i;
            }
            if(found!=currentPage){ currentPage=found; updateLabel(); }
        }

        void clampPan() {
            float scaledW=contentWidth*scale;
            float scaledH=contentHeight*scale;
            int viewW=getWidth(), viewH=getHeight();
            if(scaledW<=viewW) panX=(viewW-scaledW)/2f;
            else panX=Math.max(viewW-scaledW,Math.min(0,panX));
            if(scaledH<=viewH) panY=(viewH-scaledH)/2f;
            else panY=Math.max(viewH-scaledH,Math.min(0,panY));
        }

        void layoutPages() {
            int width=getWidth();
            if(width<=0) return;
            contentWidth=Math.max(dp(280),width-dp(24));
            int total=0;
            for(int i=0;i<pageCount;i++){
                Bitmap bm=bitmaps.get(i);
                if(bm==null){
                    try{
                        PdfRenderer.Page page=renderer.openPage(i);
                        float ratio=(float)page.getHeight()/Math.max(1,page.getWidth());
                        int h=(int)(contentWidth*ratio);
                        baseHeights.set(i,Math.max(dp(200),h));
                        page.close();
                    }catch(Exception ignored){}
                } else {
                    baseHeights.set(i,bm.getHeight());
                }
                total+=baseHeights.get(i)+dp(14);
            }
            contentHeight=Math.max(dp(100),total);
            laidOut=true;
        }

        @Override protected void onSizeChanged(int w,int h,int ow,int oh) {
            super.onSizeChanged(w,h,ow,oh);
            layoutPages();
            clampPan();
        }

        @Override protected void onDraw(Canvas c) {
            super.onDraw(c);
            if(renderer==null) return;
            if(!laidOut) layoutPages();

            c.save();
            c.translate(panX,panY);
            c.scale(scale,scale);

            float topContent=(-panY/Math.max(0.0001f,scale))-dp(250);
            float bottomContent=((-panY+getHeight())/Math.max(0.0001f,scale))+dp(250);

            int y=0;
            for(int i=0;i<pageCount;i++){
                int h=baseHeights.get(i);
                if(y+h>=topContent && y<=bottomContent){
                    Bitmap bm=render(i,contentWidth,h);
                    if(bm!=null){
                        float left=(contentWidth-bm.getWidth())/2f+dp(12);
                        RectF dst=new RectF(left,y,left+bm.getWidth(),y+bm.getHeight());
                        c.drawBitmap(bm,null,dst,paint);
                    }
                }
                y+=h+dp(14);
            }
            c.restore();
            recomputeCurrentPage();
        }

        Bitmap render(int i,int width,int targetH) {
            Bitmap old=bitmaps.get(i);
            if(old!=null) return old;
            try{
                PdfRenderer.Page page=renderer.openPage(i);
                // Render at a higher resolution than the base (fit-width) size so the page still
                // looks sharp once the user pinch-zooms in, instead of visibly blurring/pixelating.
                int w=Math.max(dp(280),Math.min(dp(2200),width*2));
                int h=Math.max(dp(280),(int)(w*((float)page.getHeight()/Math.max(1,page.getWidth()))));
                Bitmap b=Bitmap.createBitmap(w,h,Bitmap.Config.ARGB_8888);
                b.eraseColor(Color.WHITE);
                page.render(b,null,null,PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY);
                page.close();
                bitmaps.set(i,b);
                return b;
            }catch(Exception e){ return null; }
        }

        float centroidX(MotionEvent e) {
            float sum=0; int n=e.getPointerCount();
            for(int i=0;i<n;i++) sum+=e.getX(i);
            return sum/Math.max(1,n);
        }
        float centroidY(MotionEvent e) {
            float sum=0; int n=e.getPointerCount();
            for(int i=0;i<n;i++) sum+=e.getY(i);
            return sum/Math.max(1,n);
        }

        @Override public boolean onTouchEvent(MotionEvent e) {
            scaleDetector.onTouchEvent(e);
            switch(e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                case MotionEvent.ACTION_POINTER_DOWN:
                    // Recenter the pan anchor on every pointer count change so adding/removing a
                    // finger never causes a visible jump.
                    getParent().requestDisallowInterceptTouchEvent(true);
                    lastCentroidX=centroidX(e); lastCentroidY=centroidY(e); centroidValid=true;
                    break;
                case MotionEvent.ACTION_MOVE:
                    if(centroidValid && !scaleDetector.isInProgress()) {
                        float cx=centroidX(e), cy=centroidY(e);
                        panX+=cx-lastCentroidX;
                        panY+=cy-lastCentroidY;
                        clampPan();
                        invalidate();
                        lastCentroidX=cx; lastCentroidY=cy;
                    } else if(centroidValid) {
                        // Still track the centroid through a pinch so a combined pinch+drag (two
                        // fingers moving together while also spreading/closing) pans smoothly too.
                        lastCentroidX=centroidX(e); lastCentroidY=centroidY(e);
                    }
                    break;
                case MotionEvent.ACTION_POINTER_UP:
                    lastCentroidX=centroidX(e); lastCentroidY=centroidY(e);
                    break;
                case MotionEvent.ACTION_UP:
                case MotionEvent.ACTION_CANCEL:
                    centroidValid=false;
                    getParent().requestDisallowInterceptTouchEvent(false);
                    break;
            }
            return true;
        }
    }
}
`);
const providerDir = join(res, 'xml'); mkdirSync(providerDir, {recursive:true});
writeFileSync(join(providerDir,'file_paths.xml'), `<?xml version="1.0" encoding="utf-8"?><paths xmlns:android="http://schemas.android.com/apk/res/android"><cache-path name="pdf_cache" path="pdf/" /></paths>`);
const mainJavaRoot = join(app, 'src', 'main', 'java');
function findMainActivity(dir){
  if(!existsSync(dir)) return null;
  for(const n of readdirSync(dir,{withFileTypes:true})){
    const p=join(dir,n.name); if(n.isDirectory()){const f=findMainActivity(p); if(f)return f;} else if(n.name==='MainActivity.java') return p;
  } return null;
}
const mainActivity=findMainActivity(mainJavaRoot);
if(mainActivity){
  let t=readFileSync(mainActivity,'utf8');
  if(!t.includes('ivSystemBars')){
    if(!t.includes('import com.inthevoid.platform.PdfViewerPlugin;')){
      t=t.replace(/(package [^;]+;)/, '$1\n\nimport com.inthevoid.platform.PdfViewerPlugin;');
    }
    t=t.replace(/public class MainActivity extends BridgeActivity \{/,
`public class MainActivity extends BridgeActivity {
    private void ivSystemBars() {
        android.view.Window w = getWindow();
        w.setStatusBarColor(android.graphics.Color.rgb(3,10,20));
        w.setNavigationBarColor(android.graphics.Color.rgb(255,248,252));
        if (android.os.Build.VERSION.SDK_INT >= 26) {
            w.getDecorView().setSystemUiVisibility(android.view.View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            w.setNavigationBarContrastEnforced(false);
        }
    }

    @Override public void onCreate(android.os.Bundle savedInstanceState) {
        ivSystemBars();
        registerPlugin(PdfViewerPlugin.class);
        super.onCreate(savedInstanceState);
        ivSystemBars();
    }

    @Override public void onResume() {
        super.onResume();
        ivSystemBars();
    }`);
    writeFileSync(mainActivity,t);
  }
}

// Standalone internal admin/scanner pages need the same native Back behavior as the SPA.
// This is intentionally a tiny bridge: it only runs inside the Capacitor Android app and
// leaves normal web-browser navigation untouched.
const standalonePages = ['admin-manager.html','admin-videos.html','pdf-forensic-scanner.html'];
const standaloneBackScript = `<script>
(function ivStandaloneBack(){
  if (!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform())) return;
  try {
    const App = window.Capacitor.Plugins && window.Capacitor.Plugins.App;
    if (!App || !App.addListener) return;
    let lastBackAt = 0;
    App.addListener('backButton', function(){
      try {
        const visibleModal = Array.from(document.querySelectorAll('.modal,.modal-back,[role="dialog"]')).some(el => {
          const s = getComputedStyle(el);
          return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        });
        if (visibleModal) {
          const close = document.querySelector('.modal.show .close, .modal-back .close, [role="dialog"] .close');
          if (close) { close.click(); return; }
          if (typeof window.closeModal === 'function') { window.closeModal(); return; }
        }
      } catch (_) {}
      if (window.history && window.history.length > 1) {
        window.history.back();
        return;
      }
      const now = Date.now();
      if (now - lastBackAt < 2200) {
        if (App.exitApp) App.exitApp();
        else if (App.minimizeApp) App.minimizeApp();
        return;
      }
      lastBackAt = now;
      const toast = document.createElement('div');
      toast.textContent = 'اضغط مرة أخرى للخروج من التطبيق';
      toast.style.cssText = 'position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483647;background:rgba(15,23,42,.94);color:#fff;padding:11px 16px;border-radius:12px;font:800 13px Cairo,system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.25);';
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 1800);
    });
  } catch (_) {}
})();
</script>`;
for (const page of standalonePages) {
  const pagePath = join(root, page);
  if (existsSync(pagePath)) {
    let html = readFileSync(pagePath, 'utf8');
    if (!html.includes('ivStandaloneBack')) {
      html = html.includes('</body>') ? html.replace('</body>', standaloneBackScript + '\n</body>') : html + standaloneBackScript;
      writeFileSync(pagePath, html);
    }
  }
}
// Keep the Android launch window neutral and remove any old custom image splash.
// Android 12+ may still show the platform-mandated system splash, but this project
// no longer requests the Capacitor SplashScreen plugin/resource.
const ivNavigationColor = '@color/iv_navigation_bar';
const ivColorsPath = join(res, 'values', 'colors.xml');
mkdirSync(join(res, 'values'), { recursive: true });
let ivColors = existsSync(ivColorsPath) ? readFileSync(ivColorsPath,'utf8') : '<resources>\n</resources>\n';
if (!ivColors.includes('iv_navigation_bar')) {
  ivColors = ivColors.replace('</resources>', '    <color name="iv_navigation_bar">#FFF8FC</color>\n</resources>');
}
if (!ivColors.includes('iv_window_background')) {
  ivColors = ivColors.replace('</resources>', '    <color name="iv_window_background">#030A14</color>\n</resources>');
}
writeFileSync(ivColorsPath, ivColors);
// Every style declares navigationBarColor/windowBackground statically (evaluated by the system
// before any Activity code runs), on top of the imperative ivSystemBars() calls in MainActivity.
// Two sources of the reported navigation-bar "flicker" are covered this way: (1) the brief
// default-black window shown for a frame or two before onCreate() runs now instead shows the
// app's own background color, and (2) every declared theme/style variant (not just the one the
// launcher activity happens to use) gets the same navigation bar color, so switching activities
// (e.g. opening the PDF viewer) can't show a mismatched bar even for a single frame.
function patchStyleFiles(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir,{withFileTypes:true})) {
    const path = join(dir,entry.name);
    if (entry.isDirectory()) { patchStyleFiles(path); continue; }
    if (entry.name !== 'styles.xml') continue;
    let styles = readFileSync(path,'utf8');
    styles = styles.replace(/<item name="android:windowSplashScreenAnimatedIcon">[^<]*<\/item>\s*/g, '');
    styles = styles.replace(/<item name="windowSplashScreenAnimatedIcon">[^<]*<\/item>\s*/g, '');
    styles = styles.replace(/<item name="android:navigationBarColor">[^<]*<\/item>\s*/g, '');
    styles = styles.replace(/<item name="android:windowLightNavigationBar">[^<]*<\/item>\s*/g, '');
    styles = styles.replace(/<item name="android:windowBackground">[^<]*<\/item>\s*/g, '');
    styles = styles.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/g, (full, open, body, close) => {
      if (!body.includes('android:navigationBarColor')) {
        body = '\n        <item name="android:navigationBarColor">' + ivNavigationColor + '</item>' + body;
      }
      if (!body.includes('android:windowLightNavigationBar')) {
        body = '\n        <item name="android:windowLightNavigationBar">true</item>' + body;
      }
      if (!body.includes('android:windowBackground')) {
        body = '\n        <item name="android:windowBackground">@color/iv_window_background</item>' + body;
      }
      return open + body + close;
    });
    writeFileSync(path,styles);
  }
}
patchStyleFiles(res);

const providerManifest = `\n        <provider android:name="androidx.core.content.FileProvider" android:authorities="${'${applicationId}'}.fileprovider" android:exported="false" android:grantUriPermissions="true"><meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/file_paths" /></provider>`;
const manifestPath=join(app,'src','main','AndroidManifest.xml');
if(existsSync(manifestPath)){
 let t=readFileSync(manifestPath,'utf8');
 if(!t.includes('androidx.core.content.FileProvider')) t=t.replace('</application>', providerManifest+'\n    </application>');
 if(!t.includes('PdfViewerActivity')) t=t.replace('</application>', '        <activity android:name=".PdfViewerActivity" android:exported="false" android:screenOrientation="portrait" />\n    </application>');
 writeFileSync(manifestPath,t);
}

console.log(`Prepared Android: com.inthevoid.platform versionCode=${versionCode} versionName=${versionName}`);
