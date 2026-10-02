III. METODOLOGI

Pengembangan prototipe E-Fog dibagi menjadi enam tahap, mulai dari identifikasi masalah sampai evaluasi akhir. Alur lengkapnya disajikan pada Gambar 1.

Pertama, identifikasi masalah. Jaring pasif seluas 1 m² hanya berfungsi pada kabut yang sudah tebal, yaitu LWC di atas 0,5 g/m³, dan efisiensinya pun hanya 1–10%. Sebaliknya, pada mikro-kabut dengan LWC di bawah 0,1 g/m³, droplet terlalu ringan untuk menempel sehingga lolos mengikuti angin. Justru wilayah yang paling membutuhkan air tidak punya akses listrik maupun alat pemantau cuaca.

Kedua, studi konsep fisika. Empat hal menjadi landasan rancangan, yaitu pelepasan korona yang memberi muatan pada droplet sehingga gaya Coulomb menariknya ke kolektor, modul Peltier yang mendinginkan permukaan kolektor untuk memicu kondensasi tambahan ketika LWC rendah, LWC sendiri sebagai ukuran kuantitatif ketersediaan air kabut, serta integrasi IoT dan panel surya agar alat bekerja otomatis dan mandiri secara energi.

Ketiga, perancangan solusi. Prototipe disusun dari lima subsistem, yaitu emitor ion dengan catu daya HV 10–30 kV, kolektor dari jaring baja stainless 316L berukuran 300 × 400 mm yang dibumikan, modul Peltier yang dilayani kipas dan heat sink, mikrokontroler ESP32 dengan sensor BME280, anemometer, dan sensor kelembapan, serta sistem daya, mulai dari panel surya 6 V 10 W, baterai Li-ion, hingga buck-boost.

Keempat, pembuatan prototipe. Subsistem dirakit satu per satu, lalu ditulis firmware yang menyalakan HV hanya saat ambang LWC terpenuhi dan mengatur duty cycle Peltier mengikuti suhu kolektor. Integrasi IoT membuat data lingkungan dapat dipantau dari jarak jauh, sedangkan komisioning memastikan tegangan benar-benar berada di 10–30 kV dan arus tidak melampaui 50 mA.

Kelima, pengujian prototipe. Ada empat kelompok uji, yaitu kestabilan arus ionisasi pada beberapa kecepatan angin, laju pengumpulan air beserta efisiensi ekstraksi, perbandingan langsung dengan SFC pada LWC rendah, serta performa panel surya, pendinginan Peltier, dan konektivitas IoT.

Terakhir, evaluasi dan penyempurnaan. Hasil pengukuran dibandingkan dengan target efisiensi 50–90% dan laju pengumpulan 3,15–5,6 kg/m²/jam. Target yang tercapai menandai prototipe sebagai tervalidasi, sedangkan bila belum tercapai rancangan diperbaiki dan seluruh siklus diulang sejak tahap ketiga.
