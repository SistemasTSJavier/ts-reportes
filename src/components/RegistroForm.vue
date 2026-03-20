<template>
  <form class="space-y-6 text-sm" @submit.prevent="onSubmit">
    <!-- 1. Encabezado – Fecha -->
    <section class="card-section">
      <h3 class="card-section-title"><span class="card-section-title-accent" /> Fecha</h3>
      <div class="flex flex-col md:flex-row gap-3 items-start md:items-center">
        <div class="flex-1 space-y-1">
          <label class="font-semibold text-slate-700">Fecha y hora</label>
          <input
            :value="formattedFecha"
            type="text"
            readonly
            class="w-full rounded-md border border-slate-300 px-2 py-1 bg-slate-50 text-slate-800"
          />
        </div>
        <div class="space-y-1">
          <p class="text-[11px] text-slate-500">
            La fecha se asigna automáticamente al crear el registro.
          </p>
          <button
            type="button"
            class="inline-flex items-center gap-2 rounded-md bg-slate-300 px-3 py-1.5 text-xs font-semibold text-white cursor-not-allowed"
            disabled
          >
            Fecha automática
          </button>
        </div>
      </div>
    </section>

    <!-- 2. Datos personales / generales -->
    <section class="card-section">
      <h3 class="card-section-title">
        <span class="card-section-title-accent" /> Datos personales / generales
      </h3>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div class="space-y-1">
          <label class="font-semibold text-slate-700">Responsable *</label>
          <input
            v-model="form.responsable"
            type="text"
            required
            class="w-full rounded-md border border-slate-300 px-2 py-1 uppercase focus:outline-none focus:ring-1 focus:ring-tactical-blue"
            @input="toUpperField('responsable')"
          />
        </div>
        <div class="space-y-1">
          <label class="font-semibold text-slate-700">Operador *</label>
          <input
            v-model="form.operador"
            type="text"
            required
            class="w-full rounded-md border border-slate-300 px-2 py-1 uppercase focus:outline-none focus:ring-1 focus:ring-tactical-blue"
            @input="toUpperField('operador')"
          />
        </div>
        <div class="space-y-1">
          <label class="font-semibold text-slate-700">Tipo de licencia</label>
          <input
            v-model="form.tipoLicencia"
            type="text"
            class="w-full rounded-md border border-slate-300 px-2 py-1 uppercase focus:outline-none focus:ring-1 focus:ring-tactical-blue"
            @input="toUpperField('tipoLicencia')"
          />
        </div>
      </div>

      <!-- Licencia (Imagen) -->
      <div class="space-y-2">
        <label class="font-semibold text-slate-700">Licencia (imagen)</label>
        <div
          class="border border-dashed border-slate-300 rounded-md h-40 flex items-center justify-center bg-slate-50 relative overflow-hidden"
        >
          <div v-if="!form.licenciaImagen" class="flex flex-col items-center gap-1 text-slate-500">
            <span class="text-2xl">📷</span>
            <span>Toque para capturar licencia</span>
          </div>
          <img
            v-else
            :src="form.licenciaImagen"
            alt="Licencia"
            class="w-full h-full object-contain"
          />
          <input
            type="file"
            accept="image/*"
            capture="environment"
            class="absolute inset-0 opacity-0 cursor-pointer"
            @change="onPickImage('licenciaImagen', $event, 'licencia')"
          />
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div class="space-y-1">
          <label class="font-semibold text-slate-700">Número de Tracto</label>
          <input
            v-model="form.numeroTracto"
            type="text"
            class="w-full rounded-md border border-slate-300 px-2 py-1 uppercase focus:outline-none focus:ring-1 focus:ring-tactical-blue"
            @input="toUpperField('numeroTracto')"
          />
        </div>
        <div class="space-y-1">
          <label class="font-semibold text-slate-700">Vacia / Cargada</label>
          <select
            v-model="form.vaciaCargada"
            class="w-full rounded-md border border-slate-300 px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-tactical-blue"
          >
            <option value="">Seleccionar</option>
            <option value="VACIA">VACIA</option>
            <option value="CARGADA">CARGADA</option>
          </select>
        </div>
        <div class="space-y-1">
          <label class="font-semibold text-slate-700">Medidas de la caja</label>
          <input
            v-model="form.medidasCaja"
            type="text"
            class="w-full rounded-md border border-slate-300 px-2 py-1 uppercase focus:outline-none focus:ring-1 focus:ring-tactical-blue"
            @input="toUpperField('medidasCaja')"
          />
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div class="space-y-1">
          <label class="font-semibold text-slate-700">Línea Transportista *</label>
          <input
            v-model="form.lineaTransportista"
            type="text"
            required
            class="w-full rounded-md border border-slate-300 px-2 py-1 uppercase focus:outline-none focus:ring-1 focus:ring-tactical-blue"
            @input="toUpperField('lineaTransportista')"
          />
        </div>
        <div class="space-y-1">
          <label class="font-semibold text-slate-700">Línea (Americana / Nacional)</label>
          <select
            v-model="form.lineaTipo"
            class="w-full rounded-md border border-slate-300 px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-tactical-blue"
          >
            <option value="">Seleccionar</option>
            <option value="Americana">Americana</option>
            <option value="Nacional">Nacional</option>
          </select>
        </div>
        <div class="space-y-1">
          <label class="font-semibold text-slate-700">Número de Caja *</label>
          <input
            v-model="form.numeroCaja"
            type="text"
            required
            class="w-full rounded-md border border-slate-300 px-2 py-1 uppercase focus:outline-none focus:ring-1 focus:ring-tactical-blue"
            @input="toUpperField('numeroCaja')"
          />
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div class="space-y-1">
          <label class="font-semibold text-slate-700">Sello *</label>
          <input
            v-model="form.sello"
            type="text"
            required
            class="w-full rounded-md border border-slate-300 px-2 py-1 uppercase focus:outline-none focus:ring-1 focus:ring-tactical-blue"
            @input="toUpperField('sello')"
          />
        </div>
        <div class="space-y-1">
          <label class="font-semibold text-slate-700">No. de placas (Tracto) *</label>
          <input
            v-model="form.placasTracto"
            type="text"
            required
            class="w-full rounded-md border border-slate-300 px-2 py-1 uppercase focus:outline-none focus:ring-1 focus:ring-tactical-blue"
            @input="toUpperField('placasTracto')"
          />
        </div>
        <div class="space-y-1">
          <label class="font-semibold text-slate-700">No. de placas (Caja)</label>
          <input
            v-model="form.placasCaja"
            type="text"
            class="w-full rounded-md border border-slate-300 px-2 py-1 uppercase focus:outline-none focus:ring-1 focus:ring-tactical-blue"
            @input="toUpperField('placasCaja')"
          />
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div class="space-y-1">
          <label class="font-semibold text-slate-700">Origen</label>
          <input
            v-model="form.origen"
            type="text"
            class="w-full rounded-md border border-slate-300 px-2 py-1 uppercase focus:outline-none focus:ring-1 focus:ring-tactical-blue"
            @input="toUpperField('origen')"
          />
        </div>
        <div class="space-y-1">
          <label class="font-semibold text-slate-700">Entrada / Salida</label>
          <select
            v-model="form.entradaSalida"
            class="w-full rounded-md border border-slate-300 px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-tactical-blue"
          >
            <option value="">Seleccionar</option>
            <option value="Entrada">Entrada</option>
            <option value="Salida">Salida</option>
          </select>
        </div>
      </div>
    </section>

    <!-- 3. Checklist del Tracto -->
    <section class="card-section">
      <h3 class="card-section-title"><span class="card-section-title-accent" /> Checklist Tracto</h3>
      <div class="space-y-1">
        <div
          v-for="(item, index) in checklistTractoItems"
          :key="item.key"
          class="flex items-center gap-2"
        >
          <input
            v-model="form.checklistTracto[item.key]"
            type="checkbox"
            :id="`tracto-${item.key}`"
            class="h-3 w-3 rounded border-slate-300 text-tactical-blue focus:ring-tactical-blue"
          />
          <label :for="`tracto-${item.key}`" class="flex-1">
            {{ index + 1 }}. {{ item.label }}
          </label>
        </div>
      </div>
    </section>

    <!-- 4. Checklist de la Caja -->
    <section class="card-section">
      <h3 class="card-section-title"><span class="card-section-title-accent" /> Checklist Caja</h3>
      <div class="space-y-1">
        <div
          v-for="(item, index) in checklistCajaItems"
          :key="item.key"
          class="flex items-center gap-2"
        >
          <input
            v-model="form.checklistCaja[item.key]"
            type="checkbox"
            :id="`caja-${item.key}`"
            class="h-3 w-3 rounded border-slate-300 text-tactical-blue focus:ring-tactical-blue"
          />
          <label :for="`caja-${item.key}`" class="flex-1">
            {{ index + 11 }}. {{ item.label }}
          </label>
        </div>
      </div>
    </section>

    <!-- 5. Inspección Agrícola -->
    <section class="card-section">
      <h3 class="card-section-title"><span class="card-section-title-accent" /> Inspección agrícola (caja trailer)</h3>
      <div v-for="actividad in actividadesAgricolas" :key="actividad.id" class="space-y-2">
        <p class="font-semibold text-slate-700">
          Actividad Requerida {{ actividad.id }} - {{ actividad.titulo }}
        </p>
        <p class="text-slate-600">{{ actividad.descripcion }}</p>
        <div class="flex flex-col md:flex-row gap-3 items-start md:items-center">
          <label class="inline-flex items-center gap-2">
            <input
              v-model="form.inspeccionAgricolaVerificado[actividad.id]"
              type="checkbox"
              class="h-3 w-3 rounded border-slate-300 text-tactical-blue focus:ring-tactical-blue"
            />
            <span>Verificado</span>
          </label>
          <div class="flex-1 space-y-1">
            <label class="font-semibold text-slate-700">Tipo de comentario</label>
            <select
              v-model="form._contaminacionTipo[actividad.id]"
              class="w-full rounded-md border border-slate-300 px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-tactical-blue"
            >
              <option value="Sin comentario">Sin comentario</option>
              <option value="Texto libre">Texto libre</option>
            </select>
          </div>
        </div>
        <div
          v-if="form._contaminacionTipo[actividad.id] === 'Texto libre'"
          class="space-y-1 mt-1"
        >
          <label class="font-semibold text-slate-700">Descripción (solo mayúsculas)</label>
          <textarea
            v-model="form.inspeccionAgricolaContaminacion[actividad.id]"
            rows="2"
            class="w-full rounded-md border border-slate-300 px-2 py-1 uppercase focus:outline-none focus:ring-1 focus:ring-tactical-blue"
            @input="toUpperAgricola(actividad.id)"
          />
        </div>
        <hr class="border-slate-100" />
      </div>
    </section>

    <!-- 6. Inspección Mecánica -->
    <section class="card-section">
      <div class="flex items-center justify-between gap-3">
        <h3 class="card-section-title"><span class="card-section-title-accent" /> Inspección mecánica (tractor y caja)</h3>
        <label class="inline-flex items-center gap-2 text-xs text-slate-700">
          <span>Habilitar</span>
          <input
            v-model="form.inspeccionMecanicaHabilitada"
            type="checkbox"
            class="h-4 w-7 rounded-full border-slate-300 text-tactical-blue focus:ring-tactical-blue"
          />
        </label>
      </div>

      <div v-if="form.inspeccionMecanicaHabilitada" class="space-y-3">
        <!-- Tractor -->
        <div class="space-y-1">
          <p class="font-semibold text-slate-700">Tractor</p>
          <div
            v-for="(item, index) in mecanicaTractorItems"
            :key="item.key"
            class="flex items-center gap-2"
          >
            <input
              v-model="form.inspeccionMecanicaTractor[item.key]"
              type="checkbox"
              :id="`mec-tractor-${item.key}`"
              class="h-3 w-3 rounded border-slate-300 text-tactical-blue focus:ring-tactical-blue"
            />
            <label :for="`mec-tractor-${item.key}`" class="flex-1">
              {{ index + 1 }}. {{ item.label }}
            </label>
          </div>
        </div>

        <!-- Caja Trailer -->
        <div class="space-y-1">
          <p class="font-semibold text-slate-700">Caja Trailer</p>
          <div
            v-for="(item, index) in mecanicaCajaItems"
            :key="item.key"
            class="flex items-center gap-2"
          >
            <input
              v-model="form.inspeccionMecanicaCajaTrailer[item.key]"
              type="checkbox"
              :id="`mec-caja-${item.key}`"
              class="h-3 w-3 rounded border-slate-300 text-tactical-blue focus:ring-tactical-blue"
            />
            <label :for="`mec-caja-${item.key}`" class="flex-1">
              {{ index + 1 }}. {{ item.label }}
            </label>
          </div>
        </div>

        <!-- Observaciones -->
        <div class="space-y-1">
          <label class="font-semibold text-slate-700">Observaciones (solo mayúsculas)</label>
          <textarea
            v-model="form.inspeccionMecanicaObservaciones"
            rows="3"
            class="w-full rounded-md border border-slate-300 px-2 py-1 uppercase focus:outline-none focus:ring-1 focus:ring-tactical-blue"
            @input="toUpperField('inspeccionMecanicaObservaciones')"
          />
        </div>
      </div>
    </section>

    <!-- 7. Firmas -->
    <section class="card-section">
      <h3 class="card-section-title"><span class="card-section-title-accent" /> Firmas</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="space-y-2">
          <label class="font-semibold text-slate-700">Nombre del operador</label>
          <input
            v-model="form.firmaOperadorNombre"
            type="text"
            class="w-full rounded-md border border-slate-300 px-2 py-1 uppercase focus:outline-none focus:ring-1 focus:ring-tactical-blue"
            @input="toUpperField('firmaOperadorNombre')"
          />
          <p class="font-semibold text-slate-700 text-[11px]">Firma del operador (dibujar aquí)</p>
          <VueSignaturePad
            ref="operadorPad"
            class="border border-slate-300 rounded-md bg-slate-50"
            :options="{ penColor: '#000' }"
            style="width: 100%; height: 120px"
          />
          <button
            type="button"
            class="text-[11px] text-blue-700"
            @click="clearFirmaOperador"
          >
            Limpiar
          </button>
        </div>

        <div class="space-y-2">
          <label class="font-semibold text-slate-700">
            Nombre del oficial que realiza la inspección
          </label>
          <input
            v-model="form.firmaOficialNombre"
            type="text"
            class="w-full rounded-md border border-slate-300 px-2 py-1 uppercase focus:outline-none focus:ring-1 focus:ring-tactical-blue"
            @input="toUpperField('firmaOficialNombre')"
          />
          <p class="font-semibold text-slate-700 text-[11px]">
            Firma del oficial (dibujar aquí)
          </p>
          <VueSignaturePad
            ref="oficialPad"
            class="border border-slate-300 rounded-md bg-slate-50"
            :options="{ penColor: '#000' }"
            style="width: 100%; height: 120px"
          />
          <button
            type="button"
            class="text-[11px] text-blue-700"
            @click="clearFirmaOficial"
          >
            Limpiar
          </button>
        </div>
      </div>
    </section>

    <!-- 8. Comentarios -->
    <section class="card-section">
      <h3 class="card-section-title"><span class="card-section-title-accent" /> Comentarios</h3>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div class="space-y-1">
          <label class="font-semibold text-slate-700">Tipo de comentario</label>
          <select
            v-model="form._comentariosTipo"
            class="w-full rounded-md border border-slate-300 px-2 py-1 bg-white focus:outline-none focus:ring-1 focus:ring-tactical-blue"
          >
            <option value="Sin comentarios">Sin comentarios</option>
            <option value="Rechazado">Rechazado</option>
            <option value="Texto libre">Texto libre</option>
          </select>
        </div>
      </div>
      <div
        v-if="form._comentariosTipo === 'Texto libre'"
        class="space-y-1"
      >
        <label class="font-semibold text-slate-700">Comentarios (solo mayúsculas)</label>
        <textarea
          v-model="form.comentarios"
          rows="3"
          class="w-full rounded-md border border-slate-300 px-2 py-1 uppercase focus:outline-none focus:ring-1 focus:ring-tactical-blue"
          @input="toUpperField('comentarios')"
        />
      </div>
    </section>

    <!-- 9. Evidencias fotográficas -->
    <section class="card-section">
      <h3 class="card-section-title"><span class="card-section-title-accent" /> Evidencias fotográficas</h3>
      <div class="grid grid-cols-1 md:grid-cols-3 gap-3">
        <ImagePicker
          label="Evidencia Frontal"
          :image="form.evidenciaFrontal"
          @pick="onPickImage('evidenciaFrontal', $event, 'frontal')"
        />
        <ImagePicker
          label="Evidencia Lateral 1"
          :image="form.evidenciaLateral1"
          @pick="onPickImage('evidenciaLateral1', $event, 'lateral1')"
        />
        <ImagePicker
          label="Evidencia Lateral 2"
          :image="form.evidenciaLateral2"
          @pick="onPickImage('evidenciaLateral2', $event, 'lateral2')"
        />
        <ImagePicker
          label="Puertas Traseras"
          :image="form.puertasTraseras"
          @pick="onPickImage('puertasTraseras', $event, 'puertas_traseras')"
        />
        <ImagePicker
          label="Evidencia de caja abierta"
          :image="form.evidenciaCajaAbierta"
          @pick="onPickImage('evidenciaCajaAbierta', $event, 'caja_abierta')"
        />
      </div>
    </section>

    <!-- 10. Botones finales -->
    <section class="flex flex-wrap items-center justify-end gap-3 pt-2">
      <p v-if="saving" class="text-sm text-slate-500 flex items-center gap-2">
        <span class="inline-block h-4 w-4 animate-spin rounded-full border-2 border-tactical-blue border-t-transparent" />
        Guardando registro...
      </p>
      <button
        type="submit"
        class="btn-primary"
        :disabled="saving"
      >
        Guardar registro
      </button>
    </section>

    <!-- Modal de advertencia checklist crítico -->
    <div
      v-if="showCriticalModal"
      class="fixed inset-0 z-20 flex items-center justify-center p-4 bg-black/50"
    >
      <div class="card max-w-md w-full p-5 space-y-4">
        <h3 class="text-base font-semibold text-red-700">Puntos críticos no cumplidos</h3>
        <p class="text-sm text-slate-600">
          Has marcado uno o más puntos críticos como no cumplidos. ¿Deseas continuar y guardar el registro de todos modos?
        </p>
        <div class="flex justify-end gap-2">
          <button type="button" class="btn-secondary" @click="cancelCriticalModal">
            Cancelar
          </button>
          <button
            type="button"
            class="inline-flex items-center justify-center rounded-button bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700 focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
            @click="confirmCriticalModal"
          >
            Continuar y guardar
          </button>
        </div>
      </div>
    </div>
  </form>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { VueSignaturePad } from 'vue-signature-pad';
import { useRouter } from 'vue-router';
import { supabase } from '../supabaseClient';
import { useToastStore } from '../stores/toastStore';
import { useSyncStore } from '../stores/syncStore';
import ImagePicker from './ImagePicker.vue';

interface RegistroFormModel {
  fecha: string;
  responsable: string;
  operador: string;
  tipoLicencia: string;
  numeroTracto: string;
  vaciaCargada: '' | 'VACIA' | 'CARGADA';
  medidasCaja: string;
  lineaTransportista: string;
  lineaTipo: '' | 'Americana' | 'Nacional';
  numeroCaja: string;
  sello: string;
  placasTracto: string;
  placasCaja: string;
  origen: string;
  entradaSalida: '' | 'Entrada' | 'Salida';

  checklistTracto: Record<string, boolean>;
  checklistCaja: Record<string, boolean>;

  inspeccionAgricolaVerificado: Record<string, boolean>;
  inspeccionAgricolaContaminacion: Record<string, string>;
  _contaminacionTipo: Record<string, 'Sin comentario' | 'Texto libre'>;

  inspeccionMecanicaHabilitada: boolean;
  inspeccionMecanicaTractor: Record<string, boolean>;
  inspeccionMecanicaCajaTrailer: Record<string, boolean>;
  inspeccionMecanicaObservaciones: string;

  firmaOperadorNombre: string;
  firmaOficialNombre: string;
  firmaOperadorDataUrl?: string;
  firmaOficialDataUrl?: string;

  _comentariosTipo: 'Sin comentarios' | 'Rechazado' | 'Texto libre';
  comentarios: string;

  licenciaImagen: string;
  evidenciaFrontal: string;
  evidenciaLateral1: string;
  evidenciaLateral2: string;
  puertasTraseras: string;
  evidenciaCajaAbierta: string;
  exifPorEvidencia: Record<string, unknown>;

  syncStatus: 'pending' | 'synced';
}

const syncStore = useSyncStore();
const toastStore = useToastStore();
const router = useRouter();

const checklistTractoItems = [
  { key: 'DEFENSA', label: 'DEFENSA' },
  { key: 'MOTOR', label: 'MOTOR' },
  { key: 'LLANTAS', label: 'LLANTAS' },
  { key: 'CABINA', label: 'CABINA' },
  { key: 'PISO_INTERIOR', label: 'PISO INTERIOR' },
  { key: 'BATERIA', label: 'BATERIA' },
  { key: 'TANQUE_DE_AIRE', label: 'TANQUE DE AIRE' },
  { key: 'TANQUE_DE_COMBUSTIBLE', label: 'TANQUE DE COMBUSTIBLE' },
  { key: 'QUINTA_RUEDA', label: 'QUINTA RUEDA' },
  { key: 'ESCAPE', label: 'ESCAPE' }
] as const;

const checklistCajaItems = [
  { key: 'PUERTAS', label: 'PUERTAS' },
  { key: 'PISO_INTERIOR', label: 'PISO INTERIOR' },
  { key: 'PAREDES_LATERALES', label: 'PAREDES LATERALES' },
  { key: 'PARED_FRONTAL', label: 'PARED FRONTAL' },
  { key: 'TECHO', label: 'TECHO' },
  { key: 'UNIDAD_DE_REFRIGERACION', label: 'UNIDAD DE REFRIGERACION' },
  { key: 'PARED_DE_FONDO', label: 'PARED DE FONDO' }
] as const;

const actividadesAgricolas = [
  {
    id: '1',
    titulo: 'Actividad 1',
    descripcion:
      'Verificar que el equipo de transporte se encuentre libre de insectos u otros invertebrados (vivos o muertos, en cualquier etapa del ciclo de vida, incluidas las cáscaras de huevo).'
  },
  {
    id: '2',
    titulo: 'Actividad 2',
    descripcion:
      'Verificar que el transporte se encuentre libre de material orgánico de origen animal (sangre, huesos, pelo, carne, secreciones, excreciones).'
  },
  {
    id: '3',
    titulo: 'Actividad 3',
    descripcion:
      'Verificar que el equipo de transporte se encuentre libre de plantas o productos vegetales (frutas, semillas, hojas, ramas, raíces, corteza).'
  },
  {
    id: '4',
    titulo: 'Actividad 4',
    descripcion:
      'Verificar que el equipo de transporte se encuentre libre de otros materiales orgánicos (hongos, tierra, agua).'
  }
] as const;

const mecanicaTractorItems = [
  { key: 'LUCES_FRONTALES', label: 'Luces Frontales' },
  { key: 'DIRECCIONALES', label: 'Direccionales' },
  { key: 'LUCES_LATERALES', label: 'Luces Laterales' },
  { key: 'LUCES_TRASERAS', label: 'Luces Traseras' },
  { key: 'INTERMITENTES', label: 'Intermitentes' },
  { key: 'CABINA', label: 'Cabina' },
  { key: 'VIDRIO_FRONTAL', label: 'Vidrio Frontal' },
  { key: 'VIDRIO_IZQUIERDO', label: 'Vidrio izquierdo' },
  { key: 'VIDRIO_DERECHO', label: 'Vidrio derecho' }
] as const;

const mecanicaCajaItems = [
  { key: 'LUCES_TRASERAS', label: 'Luces Traseras' },
  { key: 'MANITAS', label: 'Manitas' },
  { key: 'PATINES_MANIVELA', label: 'Patines / Manivela' },
  { key: 'COPLES', label: 'Coples' },
  { key: 'GOMAS', label: 'Gomas' },
  { key: 'BISAGRAS_SOLDADAS', label: 'Bisagras Soldadas' },
  { key: 'LUZ_DE_PLACA', label: 'Luz de placa' },
  { key: 'LODERA_IZQUIERDA', label: 'Lodera izquierda' },
  { key: 'LODERA_DERECHA', label: 'Lodera derecha' }
] as const;

const initChecklist = (items: readonly { key: string }[]) => {
  const obj: Record<string, boolean> = {};
  items.forEach((i) => {
    obj[i.key] = false;
  });
  return obj;
};

const form = reactive<RegistroFormModel>({
  fecha: '',
  responsable: '',
  operador: '',
  tipoLicencia: '',
  numeroTracto: '',
  vaciaCargada: '',
  medidasCaja: '',
  lineaTransportista: '',
  lineaTipo: '',
  numeroCaja: '',
  sello: '',
  placasTracto: '',
  placasCaja: '',
  origen: '',
  entradaSalida: '',

  checklistTracto: initChecklist(checklistTractoItems),
  checklistCaja: initChecklist(checklistCajaItems),

  inspeccionAgricolaVerificado: {},
  inspeccionAgricolaContaminacion: {},
  _contaminacionTipo: actividadesAgricolas.reduce((acc, a) => {
    acc[a.id] = 'Sin comentario';
    return acc;
  }, {} as Record<string, 'Sin comentario' | 'Texto libre'>),

  inspeccionMecanicaHabilitada: false,
  inspeccionMecanicaTractor: initChecklist(mecanicaTractorItems),
  inspeccionMecanicaCajaTrailer: initChecklist(mecanicaCajaItems),
  inspeccionMecanicaObservaciones: '',

  firmaOperadorNombre: '',
  firmaOficialNombre: '',
  firmaOperadorDataUrl: undefined,
  firmaOficialDataUrl: undefined,

  _comentariosTipo: 'Sin comentarios',
  comentarios: '',

  licenciaImagen: '',
  evidenciaFrontal: '',
  evidenciaLateral1: '',
  evidenciaLateral2: '',
  puertasTraseras: '',
  evidenciaCajaAbierta: '',
  exifPorEvidencia: {},

  syncStatus: 'pending'
});

const operadorPad = ref<InstanceType<typeof VueSignaturePad> | null>(null);
const oficialPad = ref<InstanceType<typeof VueSignaturePad> | null>(null);

const saving = ref(false);
const showCriticalModal = ref(false);
const pendingSubmit = ref(false);
const fechaInput = ref<HTMLInputElement | null>(null);
const fechaLocal = ref('');

const formattedFecha = computed(() => {
  if (!form.fecha) return 'Seleccionar fecha/hora';
  return new Date(form.fecha).toLocaleString();
});

onMounted(() => {
  const now = new Date();
  form.fecha = now.toISOString();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
  fechaLocal.value = local;
});

function toUpperField(key: keyof RegistroFormModel) {
  const value = form[key];
  if (typeof value === 'string') {
    // @ts-expect-error dynamic
    form[key] = value.toUpperCase();
  }
}

function toUpperAgricola(id: string) {
  const current = form.inspeccionAgricolaContaminacion[id] || '';
  form.inspeccionAgricolaContaminacion[id] = current.toUpperCase();
}

function getJpegExifOrientation(buffer: ArrayBuffer): number {
  // Devuelve la orientación EXIF (1..8). Si no existe/está corrupto, retorna 1.
  // Referencia de etiqueta: Orientation (0x0112).
  try {
    const view = new DataView(buffer);

    // SOI marker (Start Of Image) debe ser 0xFFD8 para JPEG
    if (view.getUint16(0, false) !== 0xffd8) return 1;

    let offset = 2;
    const length = view.byteLength;

    while (offset < length) {
      const marker = view.getUint16(offset, false);
      offset += 2;

      // Llegamos al final (o algo no esperado)
      if ((marker & 0xff00) !== 0xff00) break;

      // Segment length (incluye los 2 bytes del length)
      const segmentLength = view.getUint16(offset, false);
      offset += 2;

      // APP1 (EXIF)
      if (marker === 0xffe1) {
        // Verificar "Exif\0\0"
        // Byte order del TIFF empieza luego del identificador EXIF.
        const exifStart = offset;
        const exifHeader =
          String.fromCharCode(view.getUint8(exifStart)) +
          String.fromCharCode(view.getUint8(exifStart + 1)) +
          String.fromCharCode(view.getUint8(exifStart + 2)) +
          String.fromCharCode(view.getUint8(exifStart + 3));

        if (exifHeader !== 'Exif') {
          return 1;
        }

        const tiffStart = exifStart + 6; // "Exif\0\0" son 6 bytes
        const littleEndian = view.getUint16(tiffStart, false) === 0x4949; // "II" => little endian
        const endian = littleEndian;

        const firstIfdOffset = view.getUint32(tiffStart + 4, endian);
        const ifd0 = tiffStart + firstIfdOffset;
        const entries = view.getUint16(ifd0, endian);

        for (let i = 0; i < entries; i++) {
          const entryOffset = ifd0 + 2 + i * 12;
          const tag = view.getUint16(entryOffset, endian);
          if (tag === 0x0112) {
            const orientation = view.getUint16(entryOffset + 8, endian);
            return orientation >= 1 && orientation <= 8 ? orientation : 1;
          }
        }

        return 1;
      }

      offset += segmentLength - 2;
    }
  } catch {
    return 1;
  }

  return 1;
}

async function fileToOrientedCompressedJpegDataUrl(file: File): Promise<{
  dataUrl: string;
  orientation: number;
}> {
  const buffer = await file.arrayBuffer();
  const orientation = getJpegExifOrientation(buffer);

  // Usamos blob URL para que el navegador decodifique con su pipeline normal.
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = objectUrl;
    await img.decode();

    const naturalW = img.naturalWidth || img.width;
    const naturalH = img.naturalHeight || img.height;

    // Optimización: limitamos tamaño para no guardar/mandar imágenes enormes.
    const maxDim = 1600;
    const scale = Math.min(1, maxDim / Math.max(naturalW, naturalH));
    const targetW = Math.max(1, Math.round(naturalW * scale));
    const targetH = Math.max(1, Math.round(naturalH * scale));

    const rotated = orientation >= 5 && orientation <= 8;
    const canvas = document.createElement('canvas');
    canvas.width = rotated ? targetH : targetW;
    canvas.height = rotated ? targetW : targetH;

    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('No se pudo crear canvas 2D');

    ctx.save();

    // Aplicamos transformaciones basadas en orientación EXIF.
    switch (orientation) {
      case 2:
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
        break;
      case 3:
        ctx.translate(canvas.width, canvas.height);
        ctx.rotate(Math.PI);
        break;
      case 4:
        ctx.translate(0, canvas.height);
        ctx.scale(1, -1);
        break;
      case 5:
        ctx.rotate(0.5 * Math.PI);
        ctx.scale(1, -1);
        break;
      case 6:
        ctx.rotate(0.5 * Math.PI);
        ctx.translate(0, -canvas.height);
        break;
      case 7:
        ctx.rotate(0.5 * Math.PI);
        ctx.translate(canvas.width, -canvas.height);
        ctx.scale(-1, 1);
        break;
      case 8:
        ctx.rotate(-0.5 * Math.PI);
        ctx.translate(-canvas.width, 0);
        break;
      // case 1: sin cambios
      default:
        break;
    }

    // Dibujo: al final el canvas ya está dimensionado según la rotación,
    // por lo que dibujamos ocupando todo el canvas.
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    ctx.restore();

    // Compresión: exportamos como JPEG (en evidencia/Drive/Edge funciona perfecto).
    // Calidad inicial, si se pasa de tamaño repetimos con menor calidad.
    const maxBytes = 650 * 1024; // ~650KB por imagen (ajustable)
    let quality = 0.82;
    let dataUrl = canvas.toDataURL('image/jpeg', quality);

    const approxBytes = Math.floor((dataUrl.length * 3) / 4);
    if (approxBytes > maxBytes) {
      for (const q of [0.72, 0.62, 0.52]) {
        quality = q;
        dataUrl = canvas.toDataURL('image/jpeg', quality);
        const b = Math.floor((dataUrl.length * 3) / 4);
        if (b <= maxBytes) break;
      }
    }

    return { dataUrl, orientation };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function onPickImage(
  field: keyof RegistroFormModel,
  event: Event,
  exifKey: string
) {
  const target = event.target as HTMLInputElement;
  const file = target.files?.[0];
  if (!file) return;

  const { dataUrl, orientation } = await fileToOrientedCompressedJpegDataUrl(file);

  // @ts-expect-error dynamic
  form[field] = dataUrl;
  form.exifPorEvidencia[exifKey] = {
    filename: file.name,
    size: file.size,
    orientation
  };
}

function hasCriticalFailing(): boolean {
  // Consideramos todos los ítems de checklist como críticos
  const anyTractoFail = Object.values(form.checklistTracto).some((v) => v === false);
  const anyCajaFail = Object.values(form.checklistCaja).some((v) => v === false);
  return anyTractoFail || anyCajaFail;
}

function clearFirmaOperador() {
  operadorPad.value?.clearSignature();
}

function clearFirmaOficial() {
  oficialPad.value?.clearSignature();
}

async function persistRegistro() {
  saving.value = true;

  const { data: authData } = await supabase.auth.getUser();
  const userId = authData.user?.id ?? null;
  if (!userId) {
    saving.value = false;
    toastStore.error(
      'No se pudo guardar',
      'No hay sesión activa. Inicia sesión nuevamente con Google.'
    );
    return;
  }

  const operadorData = operadorPad.value?.saveSignature();
  const oficialData = oficialPad.value?.saveSignature();

  form.firmaOperadorDataUrl = operadorData?.data;
  form.firmaOficialDataUrl = oficialData?.data;

  if (form._comentariosTipo === 'Sin comentarios') {
    form.comentarios = '';
  } else if (form._comentariosTipo === 'Rechazado') {
    form.comentarios = 'RECHAZADO';
  }

  // Si no hay internet, guardamos en una cola local para sincronizar después.
  // Importante: el folio automático y el insert a BD se harán cuando vuelva la conexión.
  const insertPayloadBase = {
    service_id: form.numeroTracto.toUpperCase() || null,
    operador: form.operador.toUpperCase(),
    checklist_tracto: {
      ...form.checklistTracto,
      datos_generales: {
        fecha: form.fecha,
        responsable: form.responsable.toUpperCase(),
        tipoLicencia: form.tipoLicencia.toUpperCase(),
        numeroTracto: form.numeroTracto.toUpperCase(),
        vaciaCargada: form.vaciaCargada,
        medidasCaja: form.medidasCaja,
        lineaTransportista: form.lineaTransportista,
        lineaTipo: form.lineaTipo,
        numeroCaja: form.numeroCaja.toUpperCase(),
        sello: form.sello.toUpperCase(),
        placasTracto: form.placasTracto.toUpperCase(),
        placasCaja: form.placasCaja.toUpperCase(),
        origen: form.origen.toUpperCase(),
        entradaSalida: form.entradaSalida
      }
    },
    checklist_caja: form.checklistCaja,
    inspeccion_agricola: {
      verificado: form.inspeccionAgricolaVerificado,
      contaminacion: form.inspeccionAgricolaContaminacion,
      tipo: form._contaminacionTipo
    },
    inspeccion_mecanica: {
      habilitada: form.inspeccionMecanicaHabilitada,
      tractor: form.inspeccionMecanicaTractor,
      cajaTrailer: form.inspeccionMecanicaCajaTrailer,
      observaciones: form.inspeccionMecanicaObservaciones
    },
    image_urls: [
      form.licenciaImagen,
      form.evidenciaFrontal,
      form.evidenciaLateral1,
      form.evidenciaLateral2,
      form.puertasTraseras,
      form.evidenciaCajaAbierta
    ].filter((x) => !!x),
    firma_operador: form.firmaOperadorDataUrl,
    firma_oficial: form.firmaOficialDataUrl,
    comentarios_tipo: form._comentariosTipo,
    comentarios: form.comentarios,
    evidencias_exif: form.exifPorEvidencia,
    user_id: userId
  };

  if (!navigator.onLine) {
    // Si la cola está llena (localStorage), se puede lanzar. En ese caso, avisamos.
    try {
      syncStore.enqueueCreateRegistroAndGenerate({ userId, insertPayloadBase });
      toastStore.info(
        'REGISTRO EN COLA (OFFLINE)',
        'Se sincronizará y generará el reporte automáticamente cuando haya internet.'
      );
      await router.push({ name: 'home' });
    } catch {
      toastStore.error(
        'No se pudo guardar offline',
        'La cola local está llena. Intenta con mejor conexión o menos imágenes.'
      );
    } finally {
      saving.value = false;
    }
    return;
  }

  // Obtener folio automático TS-0001, TS-0002, ...
  // IMPORTANTE: la función en BD ahora se llama `next_folio_ctpat(p_user_id uuid default null)`.
  // Mientras se aplica la migración (o si el backend aún no se actualizó), hacemos fallback sin parámetros.
  let folioAuto: string | null = null;
  const { data: folioData1, error: folioError1 } = await supabase.rpc('next_folio_ctpat', {
    p_user_id: userId
  });
  if (!folioError1 && folioData1) {
    folioAuto = folioData1 as string;
  } else {
    // eslint-disable-next-line no-console
    console.warn('Error con RPC next_folio_ctpat(p_user_id). Intentando fallback sin parámetros:', folioError1);
    const { data: folioData2, error: folioError2 } = await supabase.rpc('next_folio_ctpat');
    if (!folioError2 && folioData2) {
      folioAuto = folioData2 as string;
    } else {
      // eslint-disable-next-line no-console
      console.error('Error generando folio automático (fallback)', folioError2);
      saving.value = false;
      toastStore.error(
        'Error al generar folio',
        'No se pudo obtener el folio automático. Contacta al administrador.'
      );
      return;
    }
  }

  if (!folioAuto) {
    saving.value = false;
    toastStore.error('Error al generar folio', 'Folio automático viene vacío.');
    return;
  }

  const payload = {
    ...insertPayloadBase,
    folio_pdf: folioAuto,
    sync_status: 'pending'
  };

  const { data, error } = await supabase
    .from('registros_ctpat')
    .insert(payload)
    .select('id, created_at')
    .single();

  if (error) {
    // eslint-disable-next-line no-console
    console.error('Error insert registro', error);
    toastStore.error('Error al guardar el registro', error.message ?? 'Intenta nuevamente.');
    saving.value = false;
    return;
  }

  const registroId = data.id as string;

  syncStore.enqueueGeneratePdf({ registroId, folio: folioAuto });

  if (navigator.onLine) {
    void syncStore.processQueue();
  }

  saving.value = false;

  // UX: volvemos a la pantalla principal y mostramos confirmacion profesional
  toastStore.success('REGISTRO COMPLETADO!', `FOLIO: ${folioAuto}`);
  try {
    await router.push({ name: 'home' });
  } catch (e) {
    toastStore.error('Error', 'Registro guardado, pero no se pudo regresar al panel.');
  }
}

async function onSubmit() {
  if (saving.value) return;

  if (hasCriticalFailing()) {
    showCriticalModal.value = true;
    pendingSubmit.value = true;
    return;
  }

  await persistRegistro();
}

async function confirmCriticalModal() {
  showCriticalModal.value = false;
  if (!pendingSubmit.value) return;
  pendingSubmit.value = false;
  await persistRegistro();
}

function cancelCriticalModal() {
  showCriticalModal.value = false;
  pendingSubmit.value = false;
}
</script>

